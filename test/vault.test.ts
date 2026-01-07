import { beforeAll, describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import { encryptVault, decryptVault } from '../src/shared/vault'
import type { VaultData } from '../src/shared/types'

beforeAll(() => {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
  }
})

describe('vault encryption', () => {
  it('encrypts and decrypts vault data', async () => {
    const vault: VaultData = {
      accounts: [{ address: '0xabc', privateKey: '0x123' }],
      mnemonic: 'test seed phrase'
    }
    const password = 'correct horse battery staple'
    const record = await encryptVault(password, vault)
    const decrypted = await decryptVault(password, record)

    expect(decrypted).toEqual(vault)
  })
})
