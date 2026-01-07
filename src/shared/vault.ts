import type { VaultData, VaultRecord } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bufToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToBuf(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptVault(password: string, data: VaultData): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const iterations = 120_000
  const key = await deriveKey(password, salt, iterations)
  const plaintext = encoder.encode(JSON.stringify(data))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)

  return {
    ciphertext: bufToBase64(ciphertext),
    iv: bufToBase64(iv.buffer),
    salt: bufToBase64(salt.buffer),
    iterations,
    version: 1
  }
}

export async function decryptVault(password: string, record: VaultRecord): Promise<VaultData> {
  const salt = new Uint8Array(base64ToBuf(record.salt))
  const iv = new Uint8Array(base64ToBuf(record.iv))
  const key = await deriveKey(password, salt, record.iterations)
  const ciphertext = new Uint8Array(base64ToBuf(record.ciphertext))
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )
  return JSON.parse(decoder.decode(plaintext)) as VaultData
}
