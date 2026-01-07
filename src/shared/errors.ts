export type ProviderError = {
  code: number
  message: string
  data?: unknown
}

export const EIP1193_ERROR_CODES = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupported: 4200,
  internal: -32603,
  invalidParams: -32602
} as const

export class Eip1193Error extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof Eip1193Error) {
    return { code: error.code, message: error.message, data: error.data }
  }

  if (error instanceof Error) {
    return { code: EIP1193_ERROR_CODES.internal, message: error.message }
  }

  return { code: EIP1193_ERROR_CODES.internal, message: 'Unexpected error' }
}

export function userRejected(message = 'User rejected the request'): Eip1193Error {
  return new Eip1193Error(EIP1193_ERROR_CODES.userRejected, message)
}

export function unauthorized(message = 'Wallet locked or unauthorized'): Eip1193Error {
  return new Eip1193Error(EIP1193_ERROR_CODES.unauthorized, message)
}

export function unsupported(message = 'Unsupported method'): Eip1193Error {
  return new Eip1193Error(EIP1193_ERROR_CODES.unsupported, message)
}

export function invalidParams(message = 'Invalid parameters'): Eip1193Error {
  return new Eip1193Error(EIP1193_ERROR_CODES.invalidParams, message)
}
