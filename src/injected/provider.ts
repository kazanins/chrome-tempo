import { TEMPO_CHAIN_ID_HEX } from '../shared/config'
import type { ProviderRequest, ProviderResponse } from '../shared/types'

type Listener = (...args: unknown[]) => void

export class TempoProvider {
  private listeners = new Map<string, Set<Listener>>()
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()

  readonly isTempoWallet = true
  readonly isMetaMask = false
  readonly chainId = TEMPO_CHAIN_ID_HEX
  readonly networkVersion = String(parseInt(TEMPO_CHAIN_ID_HEX, 16))

  request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const id = crypto.randomUUID()
    const payload: ProviderRequest = {
      id,
      method: args.method,
      params: args.params
    } as ProviderRequest

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    window.postMessage(
      {
        type: 'TEMPO_PROVIDER_REQUEST',
        payload
      },
      '*'
    )

    return promise
  }

  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)?.add(listener)
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args))
  }

  enable(): Promise<unknown> {
    return this.request({ method: 'eth_requestAccounts' })
  }

  _handleResponse(response: ProviderResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)

    if (response.error) {
      pending.reject(new Error(response.error.message))
      return
    }

    pending.resolve(response.result)

    if (response.result && Array.isArray(response.result)) {
      this.emit('accountsChanged', response.result)
    }
  }
}

export const tempoProvider = new TempoProvider()

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  if (!event.data || event.data.type !== 'TEMPO_PROVIDER_RESPONSE') return
  const response = event.data.payload as ProviderResponse
  tempoProvider._handleResponse(response)
})

if (!window.ethereum) {
  window.ethereum = tempoProvider as unknown as typeof window.ethereum
}

if (!window.tempoWallet) {
  window.tempoWallet = tempoProvider as unknown as typeof window.ethereum
}
