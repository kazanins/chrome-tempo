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

async function respond(requestId: string, approved: boolean): Promise<void> {
  await chrome.runtime.sendMessage({
    type: 'APPROVAL_RESPONSE',
    requestId,
    approved
  })
  window.close()
}

export function ApprovalApp() {
  const [request, setRequest] = React.useState<ApprovalRequest | null>(null)
  const [error, setError] = React.useState<string>('')

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
          <strong className="mono">{request.account}</strong>
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
        {Object.entries(request.details).map(([key, value]) => (
          <div key={key} className="detail">
            <span>{key}</span>
            <strong className="mono">{value}</strong>
          </div>
        ))}
      </section>

      <div className="actions">
        <button onClick={() => respond(request.id, true)}>Approve</button>
        <button className="ghost" onClick={() => respond(request.id, false)}>
          Reject
        </button>
      </div>
    </div>
  )
}
