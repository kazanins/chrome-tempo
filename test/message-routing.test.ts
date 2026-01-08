import { beforeAll, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { TempoProvider } from '../src/injected/provider'

beforeAll(() => {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
  }
})

describe('provider routing', () => {
  it('matches request and response ids', async () => {
    const provider = new TempoProvider()
    let posted: any
    const spy = vi.spyOn(window, 'postMessage').mockImplementation((payload) => {
      posted = payload
    })

    const promise = provider.request({ method: 'eth_chainId' })
    expect(posted.type).toBe('TEMPO_PROVIDER_REQUEST')
    const id = posted.payload.id as string

    provider._handleResponse({ id, result: '0xa5bf' })
    const result = await promise

    expect(result).toBe('0xa5bf')
    spy.mockRestore()
  })
})
