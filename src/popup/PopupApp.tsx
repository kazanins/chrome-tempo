import React from 'react'
import type { ApprovalRequest, BackgroundResponse, PopupState, UIAction } from '../shared/types'
import { TEMPO_EXPLORER_URL, TEMPO_TOKENS } from '../shared/config'
import { isAddress } from 'ethers'

async function sendUiRequest<T = unknown>(action: UIAction, payload?: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage({
    type: 'UI_REQUEST',
    action,
    payload
  })) as BackgroundResponse
  if (!response.ok) {
    throw new Error(response.error?.message || 'Request failed')
  }
  return response.result as T
}

type Screen =
  | 'welcome'
  | 'create'
  | 'confirm'
  | 'import'
  | 'unlock'
  | 'approval'
  | 'home'
  | 'send'
  | 'send_confirm'
  | 'settings'
  | 'add'

export function PopupApp() {
  const normalizeAddress = (value?: string) => (value ? value.toLowerCase() : '')
  const formatAmount = (value?: string) => {
    const numeric = Number(value ?? 0)
    return Number.isFinite(numeric)
      ? new Intl.NumberFormat('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(numeric)
      : '0.00'
  }
  const [screen, setScreen] = React.useState<Screen>('welcome')
  const [state, setState] = React.useState<PopupState | null>(null)
  const [mnemonic, setMnemonic] = React.useState<string>('')
  const unlockInputRef = React.useRef<HTMLInputElement | null>(null)
  const [confirmMnemonic, setConfirmMnemonic] = React.useState<string>('')
  const [password, setPassword] = React.useState<string>('')
  const [importValue, setImportValue] = React.useState<string>('')
  const [error, setError] = React.useState<string>('')
  const [status, setStatus] = React.useState<{ message: string; txHash?: string } | null>(null)
  const [errorLog, setErrorLog] = React.useState<string[]>([])
  const [sendForm, setSendForm] = React.useState({
    token: '',
    recipient: '',
    amount: '',
    memo: ''
  })
  const [sendApproval, setSendApproval] = React.useState<{
    approval: ApprovalRequest
    rawTx: string
  } | null>(null)
  const [pendingApproval, setPendingApproval] = React.useState<ApprovalRequest | null>(null)
  const [approvalAccount, setApprovalAccount] = React.useState<string>('')
  const [approvalDropdownOpen, setApprovalDropdownOpen] = React.useState<boolean>(false)
  const [feeToken, setFeeToken] = React.useState<string>('')
  const [autoLockMinutes, setAutoLockMinutes] = React.useState<number>(5)
  const [copied, setCopied] = React.useState<boolean>(false)
  const [privateKeyCopied, setPrivateKeyCopied] = React.useState<boolean>(false)
  const [importReturnScreen, setImportReturnScreen] = React.useState<Screen>('welcome')

  React.useEffect(() => {
    refreshState()
  }, [])

  React.useEffect(() => {
    const handleClose = () => {
      chrome.runtime.sendMessage({ type: 'POPUP_CLOSED' })
    }
    window.addEventListener('beforeunload', handleClose)
    return () => window.removeEventListener('beforeunload', handleClose)
  }, [])

  React.useEffect(() => {
    const handleMessage = (message: { type?: string }) => {
      if (message?.type === 'APPROVAL_PENDING') {
        loadPendingApproval(state ?? undefined)
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage)
    return () => chrome.runtime.onMessage.removeListener(handleMessage)
  }, [state])

  React.useEffect(() => {
    if (screen === 'unlock') {
      window.setTimeout(() => unlockInputRef.current?.focus(), 0)
    }
  }, [screen])

  React.useEffect(() => {
    if (!pendingApproval) return
    setApprovalAccount((current) => {
      if (current && pendingApproval.accounts?.includes(current)) {
        return current
      }
      return pendingApproval.accounts?.[0] ?? pendingApproval.account
    })
    setApprovalDropdownOpen(false)
  }, [pendingApproval])

  function showStatus(message: string, timeoutMs = 2000, txHash?: string) {
    setStatus({ message, txHash })
    window.setTimeout(() => setStatus(null), timeoutMs)
  }

  async function refreshState() {
    try {
      const result = await sendUiRequest<PopupState>('GET_STATE')
      setState(result)
      setFeeToken(normalizeAddress(result.feeToken))
      setAutoLockMinutes(result.autoLockMinutes)
      if (!result.hasVault) {
        setScreen('welcome')
      } else if (result.locked) {
        setScreen('unlock')
      } else {
        setScreen('home')
      }
      await loadPendingApproval(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load state'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
    }
  }

  async function loadPendingApproval(currentState?: PopupState) {
    try {
      const approval = await sendUiRequest<ApprovalRequest | null>('GET_PENDING_APPROVAL')
      setPendingApproval(approval)
      if (approval && !currentState?.locked) {
        setScreen('approval')
      }
    } catch (_err) {
      setPendingApproval(null)
    }
  }

  async function handleCreateStart() {
    setError('')
    setStatus(null)
    const result = await sendUiRequest<{ mnemonic: string }>('CREATE_WALLET_START')
    setMnemonic(result.mnemonic)
    setScreen('create')
  }

  async function handleCreateFinish() {
    setError('')
    if (mnemonic.trim() !== confirmMnemonic.trim()) {
      setError('Seed phrase does not match.')
      return
    }
    try {
      await sendUiRequest('CREATE_WALLET_FINISH', { password, mnemonic })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create wallet.'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
      return
    }
    setPassword('')
    setConfirmMnemonic('')
    await refreshState()
  }

  async function handleImport() {
    setError('')
    try {
      await sendUiRequest('IMPORT_WALLET', { password, phraseOrKey: importValue })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import wallet.'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
      return
    }
    setPassword('')
    setImportValue('')
    await refreshState()
  }

  async function handleUnlock() {
    setError('')
    try {
      await sendUiRequest('UNLOCK', { password })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unlock.'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
      return
    }
    setPassword('')
    await refreshState()
  }

  async function handleSendTip20() {
    setError('')
    setStatus(null)
    if (!sendForm.token) {
      setError('Select a token.')
      return
    }
    if (!isAddress(sendForm.recipient)) {
      setError('Enter a valid recipient address.')
      return
    }
    if (!sendForm.amount || Number(sendForm.amount) <= 0) {
      setError('Enter a valid amount.')
      return
    }
    try {
      const result = await sendUiRequest<{ approval: ApprovalRequest; rawTx: string }>(
        'SEND_TIP20_PREPARE',
        { ...sendForm, feeToken }
      )
      setSendApproval(result)
      setScreen('send_confirm')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to prepare transaction.'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
    }
  }

  async function handleConfirmSend(approved: boolean) {
    if (!sendApproval) return
    if (!approved) {
      setSendApproval(null)
      setScreen('send')
      return
    }
    try {
      const result = await sendUiRequest<{ txHash: string }>('SEND_TIP20_EXECUTE', {
        rawTx: sendApproval.rawTx
      })
      showStatus('Submitted:', 3000, result.txHash)
      setSendForm({ token: '', recipient: '', amount: '', memo: '' })
      setSendApproval(null)
      setScreen('home')
      await refreshState()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send transaction.'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
    }
  }

  async function handleApprovalResponse(approved: boolean) {
    if (!pendingApproval) return
    await chrome.runtime.sendMessage({
      type: 'APPROVAL_RESPONSE',
      requestId: pendingApproval.id,
      approved,
      account: approvalAccount
    })
    setPendingApproval(null)
    await refreshState()
  }

  async function handleSettingsSave() {
    setError('')
    try {
      await sendUiRequest('SET_FEE_TOKEN', { feeToken })
      await sendUiRequest('SET_AUTO_LOCK', { minutes: autoLockMinutes })
      showStatus('Settings updated.')
      await refreshState()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save settings.'
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
    }
  }

  async function handleLock() {
    await sendUiRequest('LOCK')
    await refreshState()
  }

  function truncateAddress(address?: string) {
    if (!address) return ''
    return `${address.slice(0, 6)}…${address.slice(-4)}`
  }

  function formatAccountLabel(account: string, accountsList: string[]) {
    const index = accountsList.findIndex((entry) => entry === account)
    const labelIndex = index >= 0 ? index + 1 : 1
    return `Wallet ${labelIndex} · ${truncateAddress(account)}`
  }

  function truncateHash(hash?: string) {
    if (!hash) return ''
    return `${hash.slice(0, 10)}…${hash.slice(-6)}`
  }

  async function handleCopyAddress() {
    if (!state?.selectedAccount && !state?.address) return
    const address = state?.selectedAccount ?? state?.address
    if (!address) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        throw new Error('Clipboard API unavailable')
      }
    } catch (_error) {
      const textarea = document.createElement('textarea')
      textarea.value = address
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  function handleAddWallet() {
    setError('')
    setStatus(null)
    setScreen('add')
  }

  async function handleAddWalletCreate() {
    setError('')
    try {
      await sendUiRequest<{ address: string }>('ADD_WALLET')
      showStatus('Wallet created.')
      await refreshState()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create wallet.'
      if (message.toLowerCase().includes('locked') || message.toLowerCase().includes('unauthorized')) {
        await refreshState()
        return
      }
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
    }
  }

  async function handleAccountChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const address = event.target.value
    if (!address) return
    setError('')
    try {
      await sendUiRequest<{ address: string }>('SET_ACTIVE_ACCOUNT', { address })
      await refreshState()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to switch account.'
      if (message.toLowerCase().includes('locked') || message.toLowerCase().includes('unauthorized')) {
        await refreshState()
        return
      }
      setError(message)
      setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
    }
  }

  async function handleCopyPrivateKey() {
    setError('')
    try {
      const result = await sendUiRequest<{ privateKey: string }>('GET_PRIVATE_KEY')
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.privateKey)
      } else {
        throw new Error('Clipboard API unavailable')
      }
    } catch (_error) {
      try {
        const result = await sendUiRequest<{ privateKey: string }>('GET_PRIVATE_KEY')
        const textarea = document.createElement('textarea')
        textarea.value = result.privateKey
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to copy private key.'
        setError(message)
        setErrorLog((prev) => [`${new Date().toISOString()} ${message}`, ...prev].slice(0, 10))
        return
      }
    }
    setPrivateKeyCopied(true)
    window.setTimeout(() => setPrivateKeyCopied(false), 1200)
  }

  const selectedAddress = state?.selectedAccount ?? state?.address ?? ''
  const accounts = state?.accounts ?? (selectedAddress ? [selectedAddress] : [])

  return (
    <div className="app">
      <header className="app__header">
        {selectedAddress ? (
          <div className="header-address">
            <select
              className="wallet-select"
              value={selectedAddress}
              onChange={handleAccountChange}
              aria-label="Select wallet"
            >
              {accounts.map((address, index) => (
                <option key={address} value={address}>
                  Wallet {index + 1} · {truncateAddress(address)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`icon-button ${copied ? 'icon-button--copied' : ''}`}
              aria-label="Copy address"
              onClick={handleCopyAddress}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
                <rect x="4" y="4" width="11" height="11" rx="2" ry="2" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="header-address">
            <h1>Tempo Wallet</h1>
          </div>
        )}
        {selectedAddress && (
          <div className="header-actions">
            <button
              type="button"
              className="icon-button icon-button--primary"
              aria-label="Create new wallet"
              onClick={handleAddWallet}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <a
              className="icon-button icon-button--link"
              href={`${TEMPO_EXPLORER_URL}/address/${selectedAddress}`}
              target="_blank"
              rel="noreferrer"
              aria-label="View on explorer"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a15 15 0 0 0 0 18M12 3a15 15 0 0 1 0 18" />
              </svg>
            </a>
          </div>
        )}
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {status && (
        <div className="banner">
          <div className="banner__content">
            <span>{status.message}</span>
            {status.txHash && (
              <a
                className="banner__link"
                href={`${TEMPO_EXPLORER_URL}/tx/${status.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {truncateHash(status.txHash)}
              </a>
            )}
          </div>
        </div>
      )}

      {screen === 'welcome' && (
        <section className="card">
          <h2>Welcome</h2>
          <p>Create a Tempo-only wallet or import an existing key.</p>
          <div className="actions">
            <button onClick={handleCreateStart}>Create wallet</button>
            <button
              className="ghost"
              onClick={() => {
                setImportReturnScreen('welcome')
                setScreen('import')
              }}
            >
              Import wallet
            </button>
          </div>
        </section>
      )}

      {screen === 'add' && (
        <section className="card">
          <h2>Add wallet</h2>
          <p>Choose how you want to add another wallet.</p>
          <div className="actions">
            <button onClick={handleAddWalletCreate}>Create new wallet</button>
            <button
              className="ghost"
              onClick={() => {
                setImportReturnScreen('add')
                setScreen('import')
              }}
            >
              Import private key
            </button>
          </div>
          <div className="actions">
            <button className="ghost" onClick={() => setScreen('home')}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {screen === 'create' && (
        <section className="card">
          <h2>Seed phrase</h2>
          <p>Write this down. You will need it to confirm.</p>
          <div className="seed">{mnemonic}</div>
          <div className="actions">
            <button onClick={() => setScreen('confirm')}>I wrote it down</button>
            <button className="ghost" onClick={() => setScreen('welcome')}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {screen === 'confirm' && (
        <section className="card">
          <h2>Confirm phrase</h2>
          <label>
            Seed phrase
            <textarea
              value={confirmMnemonic}
              onChange={(event) => setConfirmMnemonic(event.target.value)}
              rows={3}
            />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={handleCreateFinish}>Create wallet</button>
            <button className="ghost" onClick={() => setScreen('welcome')}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {screen === 'import' && (
        <section className="card">
          <h2>Import wallet</h2>
          <label>
            Seed phrase or private key
            <textarea value={importValue} onChange={(event) => setImportValue(event.target.value)} rows={3} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={handleImport}>Import</button>
            <button className="ghost" onClick={() => setScreen(importReturnScreen)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {screen === 'unlock' && (
        <section className="card">
          <h2>Unlock</h2>
          <label>
            Password
            <input
              ref={unlockInputRef}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUnlock()
                }
              }}
            />
          </label>
          <div className="actions">
            <button onClick={handleUnlock}>Unlock</button>
          </div>
        </section>
      )}

      {screen === 'approval' && pendingApproval && (
        <section className="card">
          <h2>Approve</h2>
          <p className="muted">{pendingApproval.summary}</p>
          {pendingApproval.estimatedFee &&
            pendingApproval.feeTokenBalance &&
            Number(pendingApproval.estimatedFee) > Number(pendingApproval.feeTokenBalance) && (
              <div className="banner banner--warning">
                Insufficient fee token balance for the estimated fee.
              </div>
            )}
          <div className="confirm-detail">
            <span>Origin</span>
            <strong>{pendingApproval.origin}</strong>
          </div>
          <div className="confirm-detail">
            <span>Account</span>
            {pendingApproval.kind === 'connect' && pendingApproval.accounts?.length ? (
              <div className="account-select">
                <button
                  type="button"
                  className="account-trigger mono"
                  onClick={() => setApprovalDropdownOpen((open) => !open)}
                  aria-expanded={approvalDropdownOpen}
                  title={approvalAccount}
                >
                  {formatAccountLabel(approvalAccount, pendingApproval.accounts)}
                </button>
                {approvalDropdownOpen && (
                  <div className="account-list">
                    {pendingApproval.accounts.map((account) => (
                      <button
                        key={account}
                        type="button"
                        className={`account-option mono${account === approvalAccount ? ' is-active' : ''}`}
                        onClick={() => {
                          setApprovalAccount(account)
                          setApprovalDropdownOpen(false)
                        }}
                        title={account}
                      >
                        {formatAccountLabel(account, pendingApproval.accounts)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <strong className="mono">{pendingApproval.account}</strong>
            )}
          </div>
          {pendingApproval.feeToken && (
            <div className="confirm-detail">
              <span>Fee token</span>
              <strong className="mono">{pendingApproval.feeToken}</strong>
            </div>
          )}
          {pendingApproval.estimatedFee && (
            <div className="confirm-detail">
              <span>Estimated fee</span>
              <strong>{pendingApproval.estimatedFee}</strong>
            </div>
          )}
          {Object.entries(pendingApproval.details)
            .filter(([key]) => key !== 'origin' && key !== 'account')
            .map(([key, value], index) => (
              <div key={`${key}-${index}`} className="confirm-detail">
                <span>{key}</span>
                <strong className="mono">{value}</strong>
              </div>
            ))}
          <div className="actions">
            <button onClick={() => handleApprovalResponse(true)}>Approve</button>
            <button className="ghost" onClick={() => handleApprovalResponse(false)}>
              Reject
            </button>
          </div>
        </section>
      )}

      {screen === 'home' && state && (
        <section className="card">
          <div className="balance-hero">
            <span>Total Balance</span>
              <strong>{formatAmount(state.totalBalance)}</strong>
            <small>USD Stablecoins</small>
          </div>
          <div>
            <div className="token-list">
              {TEMPO_TOKENS.map((token) => (
                <div key={token.address} className="token-row">
                  <div className="token-meta">
                    <span className={`token-icon token-icon--${token.symbol.toLowerCase()}`} aria-hidden="true">
                      {token.symbol[0]}
                    </span>
                    <strong>{token.symbol}</strong>
                  </div>
                  <div className="token-amount">
                    {formatAmount(state.tokenBalances?.[token.symbol])}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Connected sites</span>
            {Object.keys(state.connections).length === 0 ? (
              <p className="muted">No active connections.</p>
            ) : (
              Object.entries(state.connections).map(([origin, info]) => (
                <div key={origin} className="list-item">
                  <span>{origin}</span>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {screen === 'send' && (
        <section className="card">
          <h2>Send TIP-20</h2>
          <label>
            Token
            <select
              value={sendForm.token}
              onChange={(event) => setSendForm({ ...sendForm, token: event.target.value })}
            >
              <option value="">Select token</option>
              {TEMPO_TOKENS.map((token) => (
                <option key={token.address} value={token.address}>
                  {token.symbol}
                </option>
              ))}
            </select>
          </label>
          <label>
            Recipient
            <input
              value={sendForm.recipient}
              onChange={(event) => setSendForm({ ...sendForm, recipient: event.target.value })}
            />
          </label>
          <label>
            Amount (6 decimals)
            <input
              value={sendForm.amount}
              onChange={(event) => setSendForm({ ...sendForm, amount: event.target.value })}
            />
          </label>
          <label>
            Memo (optional)
            <input
              value={sendForm.memo}
              onChange={(event) => setSendForm({ ...sendForm, memo: event.target.value })}
            />
          </label>
          <div className="actions">
            <button
              onClick={handleSendTip20}
              disabled={!sendForm.token || !sendForm.recipient || !sendForm.amount}
            >
              Send
            </button>
            <button className="ghost" onClick={() => setScreen('home')}>
              Back
            </button>
          </div>
        </section>
      )}

      {errorLog.length > 0 && (
        <section className="card">
          <h2>Error Log</h2>
          <div className="error-log">
            {errorLog.map((entry) => (
              <div key={entry} className="mono">
                {entry}
              </div>
            ))}
          </div>
        </section>
      )}

      {screen === 'send_confirm' && sendApproval && (
        <section className="card">
          <h2>Confirm Send</h2>
          {sendApproval.approval.estimatedFee &&
            sendApproval.approval.feeTokenBalance &&
            Number(sendApproval.approval.estimatedFee) >
              Number(sendApproval.approval.feeTokenBalance) && (
              <div className="banner banner--warning">
                Insufficient fee token balance for the estimated fee.
              </div>
            )}
          {(() => {
            const tokenInfo = TEMPO_TOKENS.find(
              (token) =>
                normalizeAddress(token.address) ===
                normalizeAddress(sendApproval.approval.details.token)
            )
            const symbol = tokenInfo?.symbol ?? 'TIP-20'
            const iconClass = `token-icon token-icon--${symbol.toLowerCase()}`
            const formattedAmount = `${sendApproval.approval.details.amount} ${symbol}`
            const feeTokenInfo = TEMPO_TOKENS.find(
              (token) =>
                normalizeAddress(token.address) ===
                normalizeAddress(sendApproval.approval.feeToken)
            )
            const feeTokenSymbol = feeTokenInfo?.symbol ?? sendApproval.approval.feeToken
            const feeIconClass = `token-icon token-icon--${feeTokenSymbol.toLowerCase()}`
            return (
              <>
                <div className="confirm-detail">
                  <span>Amount</span>
                  <div className="confirm-inline">
                    <span className={iconClass} aria-hidden="true">
                      {symbol[0]}
                    </span>
                    <strong>{formattedAmount}</strong>
                  </div>
                </div>
                <div className="confirm-detail">
                  <span>Recipient</span>
                  <strong className="mono">{sendApproval.approval.details.recipient}</strong>
                </div>
                <div className="confirm-detail">
                  <span>Estimated fee</span>
                  <div className="confirm-inline">
                    <span className={feeIconClass} aria-hidden="true">
                      {feeTokenSymbol[0]}
                    </span>
                    <strong>{sendApproval.approval.estimatedFee}</strong>
                    <span className="confirm-token">{feeTokenSymbol}</span>
                  </div>
                </div>
              </>
            )
          })()}
          {sendApproval.approval.details.memo && (
            <div className="confirm-detail">
              <span>Memo</span>
              <strong>{sendApproval.approval.details.memo}</strong>
            </div>
          )}
          <div className="actions">
            <button onClick={() => handleConfirmSend(true)}>Confirm</button>
            <button className="ghost" onClick={() => handleConfirmSend(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {screen === 'settings' && state && (
        <section className="card">
          <h2>Settings</h2>
          <label>
            RPC URL
            <input value={state.rpcUrl} readOnly />
          </label>
          <label>
            Default fee token
            <select value={feeToken} onChange={(event) => setFeeToken(event.target.value)}>
              {TEMPO_TOKENS.map((token) => (
                <option key={token.address} value={normalizeAddress(token.address)}>
                  {token.symbol}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-row">
            <span>Export private key</span>
            <button className="ghost" onClick={handleCopyPrivateKey}>
              {privateKeyCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <label>
            Auto-lock (minutes)
            <input
              type="number"
              min={1}
              value={autoLockMinutes}
              onChange={(event) => setAutoLockMinutes(Number(event.target.value))}
            />
          </label>
          <div className="actions">
            <button onClick={handleSettingsSave}>Save</button>
            <button className="ghost" onClick={() => setScreen('home')}>
              Back
            </button>
            <button className="ghost" onClick={handleLock}>
              Lock now
            </button>
          </div>
        </section>
      )}

      {state?.hasVault && !state.locked && screen !== 'approval' && (
        <nav className="bottom-nav">
          <button
            className={screen === 'home' ? 'active' : ''}
            onClick={() => setScreen('home')}
          >
            Home
          </button>
          <button
            className={screen === 'send' ? 'active' : ''}
            onClick={() => setScreen('send')}
          >
            Send
          </button>
          <button
            className={screen === 'settings' ? 'active' : ''}
            onClick={() => setScreen('settings')}
          >
            Settings
          </button>
        </nav>
      )}
    </div>
  )
}
