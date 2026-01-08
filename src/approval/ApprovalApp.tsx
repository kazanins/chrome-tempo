import React from 'react'
import type { ApprovalRequest, BackgroundResponse } from '../shared/types'

async function getApproval(requestId: string): Promise<ApprovalRequest> {
  const response = (await chrome.runtime.sendMessage({
    type: 'APPROVAL_GET',
    requestId
  })) as BackgroundResponse
  if (!response.ok) {
    throw new Error(response.error?.message || 'Approval not found')
  }
  return response.result as ApprovalRequest
}

async function respond(requestId: string, approved: boolean, account?: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'APPROVAL_RESPONSE',
    requestId,
    approved,
    account
  })
  window.close()
}

export function ApprovalApp() {
  const [request, setRequest] = React.useState<ApprovalRequest | null>(null)
  const [error, setError] = React.useState<string>('')
  const [selectedAccount, setSelectedAccount] = React.useState<string>('')
  const [dropdownOpen, setDropdownOpen] = React.useState<boolean>(false)

  function truncateAddress(address?: string) {
    if (!address) return ''
    return `${address.slice(0, 6)}…${address.slice(-4)}`
  }

  function formatAccountLabel(account: string, accountsList: string[]) {
    const index = accountsList.findIndex((entry) => entry === account)
    const labelIndex = index >= 0 ? index + 1 : 1
    return `Wallet ${labelIndex} · ${truncateAddress(account)}`
  }

  React.useEffect(() => {
    if (!request) return
    setSelectedAccount((current) => {
      if (current && request.accounts?.includes(current)) {
        return current
      }
      return request.accounts?.[0] ?? request.account
    })
    setDropdownOpen(false)
  }, [request])

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestId = params.get('requestId')
    if (!requestId) {
      setError('Missing request id')
      return
    }
    getApproval(requestId)
      .then(setRequest)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
  }, [])

  if (error) {
    return <div className="approval"><div className="banner error">{error}</div></div>
  }

  if (!request) {
    return <div className="approval">Loading…</div>
  }

  const hasInsufficientFee =
    request.estimatedFee &&
    request.feeTokenBalance &&
    Number(request.estimatedFee) > Number(request.feeTokenBalance)

  return (
    <div className="approval">
      <header>
        <h1>Approve</h1>
        <p>{request.summary}</p>
      </header>

      <section className="card">
        {hasInsufficientFee && (
          <div className="banner warning">
            Insufficient fee token balance for the estimated fee.
          </div>
        )}
        <div className="detail">
          <span>Origin</span>
          <strong>{request.origin}</strong>
        </div>
        <div className="detail">
          <span>Account</span>
          {request.kind === 'connect' && request.accounts?.length ? (
            <div className="account-select">
              <button
                type="button"
                className="account-trigger mono"
                onClick={() => setDropdownOpen((open) => !open)}
                aria-expanded={dropdownOpen}
                title={selectedAccount}
              >
                {formatAccountLabel(selectedAccount, request.accounts)}
              </button>
              {dropdownOpen && (
                <div className="account-list">
                  {request.accounts.map((account) => (
                    <button
                      key={account}
                      type="button"
                      className={`account-option mono${account === selectedAccount ? ' is-active' : ''}`}
                      onClick={() => {
                        setSelectedAccount(account)
                        setDropdownOpen(false)
                      }}
                      title={account}
                    >
                      {formatAccountLabel(account, request.accounts)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <strong className="mono">{request.account}</strong>
          )}
        </div>
        {request.feeToken && (
          <div className="detail">
            <span>Fee token</span>
            <strong className="mono">{request.feeToken}</strong>
          </div>
        )}
        {request.estimatedFee && (
          <div className="detail">
            <span>Estimated fee</span>
            <strong>{request.estimatedFee}</strong>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Details</h2>
        {Object.entries(request.details)
          .filter(([key]) => key !== 'origin' && key !== 'account')
          .map(([key, value], index) => (
            <div key={`${key}-${index}`} className="detail">
              <span>{key}</span>
              <strong className="mono">{value}</strong>
            </div>
          ))}
      </section>

      <div className="actions">
        <button onClick={() => respond(request.id, true, selectedAccount)}>Approve</button>
        <button className="ghost" onClick={() => respond(request.id, false)}>
          Reject
        </button>
      </div>
    </div>
  )
}
