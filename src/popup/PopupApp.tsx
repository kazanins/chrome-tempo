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
  const [sendValidation, setSendValidation] = React.useState({
    recipient: { status: 'idle' as 'idle' | 'valid' | 'invalid' | 'checking', message: '' },
    amount: { status: 'idle' as 'idle' | 'valid' | 'invalid', message: '' }
  })
  const [sendApproval, setSendApproval] = React.useState<{
    approval: ApprovalRequest
    rawTx: string
  } | null>(null)
  const [pendingApproval, setPendingApproval] = React.useState<ApprovalRequest | null>(null)
  const [approvalAccount, setApprovalAccount] = React.useState<string>('')
  const [approvalDropdownOpen, setApprovalDropdownOpen] = React.useState<boolean>(false)
  const [walletDropdownOpen, setWalletDropdownOpen] = React.useState<boolean>(false)
  const [tokenDropdownOpen, setTokenDropdownOpen] = React.useState<boolean>(false)
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

  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (sendForm.recipient) {
        setSendValidation((prev) => ({
          ...prev,
          recipient: { status: 'checking', message: '' }
        }))
        const result = validateRecipientAddress(sendForm.recipient)
        setSendValidation((prev) => ({
          ...prev,
          recipient: {
            status: result.valid ? 'valid' : 'invalid',
            message: result.message
          }
        }))
      } else {
        setSendValidation((prev) => ({
          ...prev,
          recipient: { status: 'idle', message: '' }
        }))
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [sendForm.recipient, state?.selectedAccount, state?.address])

  React.useEffect(() => {
    if (sendForm.amount && sendForm.token) {
      const tokenInfo = getTokenByAddress(sendForm.token)
      if (tokenInfo) {
        const result = validateAmount(sendForm.amount, tokenInfo.symbol)
        setSendValidation((prev) => ({
          ...prev,
          amount: {
            status: result.valid ? 'valid' : 'invalid',
            message: result.message
          }
        }))
      }
    } else {
      setSendValidation((prev) => ({
        ...prev,
        amount: { status: 'idle', message: '' }
      }))
    }
  }, [sendForm.amount, sendForm.token, state?.tokenBalances])

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

  function validateRecipientAddress(address: string): { valid: boolean; message: string } {
    if (!address.trim()) {
      return { valid: false, message: '' }
    }

    if (!isAddress(address)) {
      return { valid: false, message: 'Invalid address format' }
    }

    const currentAddress = state?.selectedAccount ?? state?.address
    if (currentAddress && address.toLowerCase() === currentAddress.toLowerCase()) {
      return { valid: false, message: 'Cannot send to yourself' }
    }

    return { valid: true, message: 'Valid address' }
  }

  function validateAmount(amount: string, tokenSymbol: string): { valid: boolean; message: string } {
    if (!amount.trim()) {
      return { valid: false, message: '' }
    }

    const numAmount = Number(amount)
    if (isNaN(numAmount) || numAmount <= 0) {
      return { valid: false, message: 'Amount must be greater than 0' }
    }

    const decimalPart = amount.split('.')[1]
    if (decimalPart && decimalPart.length > 6) {
      return { valid: false, message: 'Maximum 6 decimal places' }
    }

    if (state?.tokenBalances && state.tokenBalances[tokenSymbol]) {
      const balance = Number(state.tokenBalances[tokenSymbol])
      if (numAmount > balance) {
        return { valid: false, message: `Insufficient balance (${balance} ${tokenSymbol})` }
      }
    }

    return { valid: true, message: 'Valid amount' }
  }

  function formatTokenAmount(value: string, decimals: number = 6): string {
    if (!value) return '0'
    const parts = value.split('.')
    if (parts.length === 1) return value
    return `${parts[0]}.${parts[1].slice(0, decimals)}`
  }

  function getTokenByAddress(address: string) {
    return TEMPO_TOKENS.find(
      (t) => normalizeAddress(t.address) === normalizeAddress(address)
    )
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

  function handleMaxAmount() {
    if (!sendForm.token || !state?.tokenBalances) return

    const tokenInfo = getTokenByAddress(sendForm.token)
    if (!tokenInfo) return

    const balance = state.tokenBalances[tokenInfo.symbol] || '0'
    setSendForm({ ...sendForm, amount: balance })
  }

  async function handlePasteRecipient() {
    const input = document.querySelector('input[placeholder="0x..."]') as HTMLInputElement
    if (!input) return

    try {
      // Try modern clipboard API first
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        if (isAddress(text)) {
          setSendForm({ ...sendForm, recipient: text })
        } else {
          setError('Clipboard does not contain a valid address')
        }
      } else {
        // Fallback: focus input and trigger paste
        input.focus()
        document.execCommand('paste')
      }
    } catch (err) {
      // If clipboard API fails, just focus the input so user can paste manually
      input.focus()
      input.select()
    }
  }

  function handleClearRecipient() {
    setSendForm({ ...sendForm, recipient: '' })
    setSendValidation((prev) => ({
      ...prev,
      recipient: { status: 'idle', message: '' }
    }))
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

  async function handleAccountChange(address: string) {
    if (!address) return

    // Check if "Create new wallet" was selected
    if (address === '__create_new__') {
      handleAddWallet()
      setWalletDropdownOpen(false)
      return
    }

    setError('')
    setWalletDropdownOpen(false)
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
      {screen !== 'unlock' && (
        <header className="app__header">
          {selectedAddress ? (
          <div className="header-address">
            <div className="account-select">
              <button
                type="button"
                className="account-trigger mono"
                onClick={() => setWalletDropdownOpen((open) => !open)}
                aria-expanded={walletDropdownOpen}
                title={selectedAddress}
              >
                {formatAccountLabel(selectedAddress, accounts)}
              </button>
              {walletDropdownOpen && (
                <div className="account-list">
                  {accounts.map((address) => (
                    <button
                      key={address}
                      type="button"
                      className={`account-option mono${address === selectedAddress ? ' is-active' : ''}`}
                      onClick={() => handleAccountChange(address)}
                      title={address}
                    >
                      {formatAccountLabel(address, accounts)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="account-option account-option--action"
                    onClick={() => handleAccountChange('__create_new__')}
                  >
                    + Create new wallet
                  </button>
                </div>
              )}
            </div>
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
              className={`icon-button ${copied ? 'icon-button--copied' : ''}`}
              aria-label="Copy address"
              onClick={handleCopyAddress}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Settings"
              onClick={() => setScreen('settings')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            <a
              className="icon-button icon-button--link"
              href={`${TEMPO_EXPLORER_URL}/address/${selectedAddress}`}
              target="_blank"
              rel="noreferrer"
              aria-label="View on explorer"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
            </a>
          </div>
        )}
        </header>
      )}

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
        <div className="unlock-screen">
          <img src="https://raw.githubusercontent.com/tempoxyz/.github/refs/heads/main/assets/combomark-bright.svg" alt="Tempo" className="unlock-logo" />
          <h2 className="unlock-title">Unlock with password</h2>
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
            placeholder="Enter password"
            className="unlock-input"
          />
          <button onClick={handleUnlock} className="button-large button-unlock">
            Unlock
          </button>
        </div>
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
        <>
          <section className="card">
            <div className="balance-hero">
              <span>Total Balance</span>
              <strong>{formatAmount(state.totalBalance)}</strong>
              <small>USD Stablecoins</small>
            </div>
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
          </section>
          <button className="button-large button-large--primary" onClick={() => setScreen('send')}>
            Send
          </button>
          <button className="ghost button-secondary" onClick={handleLock}>
            Lock now
          </button>
          <div className="connection-status">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="connection-icon">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
              <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
              <line x1="12" y1="20" x2="12.01" y2="20"></line>
            </svg>
            {Object.keys(state.connections).length > 0 ? (
              <strong>{Object.keys(state.connections)[0]}</strong>
            ) : (
              <span className="not-connected">Not connected</span>
            )}
          </div>
        </>
      )}

      {screen === 'send' && (
        <div className="send-flow">
          <div className="send-flow__header">
            <button
              type="button"
              className="icon-button"
              aria-label="Back to home"
              onClick={() => setScreen('home')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <h2>Send</h2>
            <div style={{ width: '30px' }}></div>
          </div>

          <div className="form-section">
            <label>
              Amount
              <div className="amount-token-group">
                <div className="input-with-validation amount-input">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={sendForm.amount}
                    onChange={(event) => {
                      const value = event.target.value
                      if (value === '' || /^\d*\.?\d*$/.test(value)) {
                        setSendForm({ ...sendForm, amount: value })
                      }
                    }}
                    placeholder="0.00"
                    disabled={!sendForm.token}
                  />
                  {sendValidation.amount.status === 'valid' && (
                    <span className="validation-icon validation-icon--valid">✓</span>
                  )}
                  {sendValidation.amount.status === 'invalid' && (
                    <span className="validation-icon validation-icon--invalid">✗</span>
                  )}
                </div>
                <div className="token-select-wrapper">
                  <button
                    type="button"
                    className="token-select-trigger"
                    onClick={() => setTokenDropdownOpen((open) => !open)}
                    aria-expanded={tokenDropdownOpen}
                  >
                    {sendForm.token
                      ? TEMPO_TOKENS.find((t) => t.address === sendForm.token)?.symbol || 'Token'
                      : 'Token'}
                  </button>
                  {tokenDropdownOpen && (
                    <div className="token-select-dropdown">
                      {TEMPO_TOKENS.map((token) => (
                        <button
                          key={token.address}
                          type="button"
                          className={`token-option${token.address === sendForm.token ? ' is-active' : ''}`}
                          onClick={() => {
                            setSendForm({ ...sendForm, token: token.address })
                            setSendValidation((prev) => ({
                              ...prev,
                              amount: { status: 'idle', message: '' }
                            }))
                            setTokenDropdownOpen(false)
                          }}
                        >
                          {token.symbol}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="helper-button helper-button--max"
                  onClick={handleMaxAmount}
                  disabled={!sendForm.token}
                  title="Use maximum available balance"
                >
                  MAX
                </button>
              </div>
              {sendForm.token &&
                (() => {
                  const tokenInfo = getTokenByAddress(sendForm.token)
                  const balance = tokenInfo ? state?.tokenBalances?.[tokenInfo.symbol] : undefined
                  const isInsufficient =
                    sendValidation.amount.status === 'invalid' &&
                    sendValidation.amount.message.includes('Insufficient')
                  return balance ? (
                    <span className={`balance-hint ${isInsufficient ? 'balance-hint--insufficient' : ''}`}>
                      Available: <span className="balance-value">{balance} {tokenInfo?.symbol}</span>
                    </span>
                  ) : null
                })()}
              {sendValidation.amount.message && (
                <span className={`validation-message validation-message--${sendValidation.amount.status}`}>
                  {sendValidation.amount.status === 'valid' ? '✓' : '✗'}{' '}
                  {sendValidation.amount.message}
                </span>
              )}
            </label>
          </div>

          <div className="form-section">
            <label>
              Recipient Address
              {sendValidation.recipient.message && (
                <span
                  className={`validation-message validation-message--${sendValidation.recipient.status}`}
                >
                  {sendValidation.recipient.status === 'valid' ? '✓' : '✗'}{' '}
                  {sendValidation.recipient.message}
                </span>
              )}
              <div className="input-group">
                <div className="input-with-validation">
                  <input
                    value={sendForm.recipient}
                    onChange={(event) =>
                      setSendForm({ ...sendForm, recipient: event.target.value })
                    }
                    placeholder="0x..."
                  />
                  {sendValidation.recipient.status === 'checking' && (
                    <span className="validation-icon validation-icon--checking">⟳</span>
                  )}
                  {sendValidation.recipient.status === 'valid' && (
                    <span className="validation-icon validation-icon--valid">✓</span>
                  )}
                  {sendValidation.recipient.status === 'invalid' && (
                    <span className="validation-icon validation-icon--invalid">✗</span>
                  )}
                </div>
                {!sendForm.recipient ? (
                  <button
                    type="button"
                    className="helper-button helper-button--icon"
                    onClick={handlePasteRecipient}
                    title="Paste address"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="helper-button helper-button--icon"
                    onClick={handleClearRecipient}
                    title="Clear"
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </label>
          </div>

          <div className="form-section">
            <label>
              Memo (optional)
              <input
                value={sendForm.memo}
                onChange={(event) =>
                  setSendForm({ ...sendForm, memo: event.target.value.slice(0, 32) })
                }
                placeholder="Payment note"
                maxLength={32}
              />
            </label>
          </div>

          <button
            className="button-large button-large--primary"
            onClick={handleSendTip20}
            disabled={
              !sendForm.token ||
              !sendForm.recipient ||
              !sendForm.amount ||
              sendValidation.recipient.status !== 'valid' ||
              sendValidation.amount.status !== 'valid'
            }
          >
            Review Transaction
          </button>
        </div>
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
        <div className="send-flow">
          <div className="send-flow__header">
            <button
              type="button"
              className="icon-button"
              aria-label="Back to send"
              onClick={() => {
                setSendApproval(null)
                setScreen('send')
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <h2>Confirm</h2>
            <div style={{ width: '30px' }}></div>
          </div>

          {sendApproval.approval.estimatedFee &&
            sendApproval.approval.feeTokenBalance &&
            Number(sendApproval.approval.estimatedFee) >
              Number(sendApproval.approval.feeTokenBalance) && (
              <div className="banner banner--warning">
                <strong>Warning:</strong> Insufficient fee token balance. Transaction may fail.
              </div>
            )}
          <div className="confirm-card">
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
          </div>

          <button className="button-large button-large--primary" onClick={() => handleConfirmSend(true)}>
            Confirm & Send
          </button>
        </div>
      )}

      {screen === 'settings' && state && (
        <div className="send-flow">
          <div className="send-flow__header">
            <button
              type="button"
              className="icon-button"
              aria-label="Back to home"
              onClick={() => setScreen('home')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <h2>Settings</h2>
            <div style={{ width: '30px' }}></div>
          </div>

          <div className="form-section">
            <label>
              RPC URL
              <input value={state.rpcUrl} readOnly />
            </label>
          </div>

          <div className="form-section">
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
          </div>

          <div className="form-section">
            <div className="settings-row">
              <span>Export private key</span>
              <button className="ghost" onClick={handleCopyPrivateKey}>
                {privateKeyCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="form-section">
            <label>
              Auto-lock (minutes)
              <input
                type="number"
                min={1}
                value={autoLockMinutes}
                onChange={(event) => setAutoLockMinutes(Number(event.target.value))}
              />
            </label>
          </div>

          <button className="button-large button-large--primary" onClick={handleSettingsSave}>
            Save Settings
          </button>
        </div>
      )}

    </div>
  )
}
