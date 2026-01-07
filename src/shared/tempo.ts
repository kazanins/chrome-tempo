import { encodeRlp, getAddress, getBytes, hexlify, keccak256, concat, toBeHex, Signature } from 'ethers'
import { TEMPO_TX_TYPE } from './config'

export type TempoCall = {
  to: string
  value: bigint
  input: string
}

export type TempoTxFields = {
  chainId: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gasLimit: bigint
  calls: TempoCall[]
  accessList: Array<unknown>
  nonceKey: bigint
  nonce: bigint
  validBefore?: bigint | null
  validAfter?: bigint | null
  feeToken?: string | null
  feePayerSignature?: string | null
  aaAuthorizationList: Array<unknown>
  keyAuthorization?: unknown | null
}

function rlpNumber(value: bigint): string {
  if (value === 0n) return '0x'
  return toBeHex(value)
}

export function encodeCall(call: TempoCall): unknown[] {
  return [getAddress(call.to), rlpNumber(call.value), call.input]
}

function optionalRlpValue(value?: bigint | string | null): string {
  if (value === undefined || value === null) return '0x'
  if (typeof value === 'string') {
    return value
  }
  return toBeHex(value)
}

export function buildSenderHash(fields: TempoTxFields, feePayerPresent: boolean): string {
  const rlpPayload = [
    rlpNumber(fields.chainId),
    rlpNumber(fields.maxPriorityFeePerGas),
    rlpNumber(fields.maxFeePerGas),
    rlpNumber(fields.gasLimit),
    fields.calls.map(encodeCall),
    fields.accessList,
    rlpNumber(fields.nonceKey),
    rlpNumber(fields.nonce),
    optionalRlpValue(fields.validBefore ?? null),
    optionalRlpValue(fields.validAfter ?? null),
    feePayerPresent ? '0x' : optionalRlpValue(fields.feeToken ?? null),
    feePayerPresent ? '0x00' : '0x'
  ]

  const encoded = encodeRlp(rlpPayload)
  const typed = concat([new Uint8Array([TEMPO_TX_TYPE]), getBytes(encoded)])
  return keccak256(typed)
}

export function buildFeePayerHash(fields: TempoTxFields, senderAddress: string): string {
  const rlpPayload: unknown[] = [
    rlpNumber(fields.chainId),
    rlpNumber(fields.maxPriorityFeePerGas),
    rlpNumber(fields.maxFeePerGas),
    rlpNumber(fields.gasLimit),
    fields.calls.map(encodeCall),
    fields.accessList,
    rlpNumber(fields.nonceKey),
    rlpNumber(fields.nonce),
    optionalRlpValue(fields.validBefore ?? null),
    optionalRlpValue(fields.validAfter ?? null),
    optionalRlpValue(fields.feeToken ?? null),
    getAddress(senderAddress)
  ]

  if (fields.keyAuthorization) {
    rlpPayload.push(fields.keyAuthorization)
  }

  const encoded = encodeRlp(rlpPayload)
  const typed = concat([new Uint8Array([0x78]), getBytes(encoded)])
  return keccak256(typed)
}

export function serializeTempoTransaction(
  fields: TempoTxFields,
  senderSignature: string
): string {
  const feePayerSignature = fields.feePayerSignature
    ? (() => {
        const signature = Signature.from(fields.feePayerSignature)
        return [toBeHex(signature.v), signature.r, signature.s]
      })()
    : '0x'
  const rlpPayload: unknown[] = [
    rlpNumber(fields.chainId),
    rlpNumber(fields.maxPriorityFeePerGas),
    rlpNumber(fields.maxFeePerGas),
    rlpNumber(fields.gasLimit),
    fields.calls.map(encodeCall),
    fields.accessList,
    rlpNumber(fields.nonceKey),
    rlpNumber(fields.nonce),
    optionalRlpValue(fields.validBefore ?? null),
    optionalRlpValue(fields.validAfter ?? null),
    optionalRlpValue(fields.feeToken ?? null),
    feePayerSignature,
    fields.aaAuthorizationList
  ]

  if (fields.keyAuthorization) {
    rlpPayload.push(fields.keyAuthorization)
  }

  rlpPayload.push(senderSignature)

  const encoded = encodeRlp(rlpPayload)
  const typed = concat([new Uint8Array([TEMPO_TX_TYPE]), getBytes(encoded)])
  return hexlify(typed)
}
