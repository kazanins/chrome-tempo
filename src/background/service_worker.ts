import {
  Interface,
  Wallet,
  getAddress,
  getBytes,
  hexlify,
  isHexString,
  encodeBytes32String,
  parseUnits,
  formatUnits
} from 'ethers'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import {
  DEFAULT_FEE_TOKEN,
  TEMPO_CHAIN_ID,
  TEMPO_CHAIN_ID_HEX,
  TEMPO_RPC_URL,
  TEMPO_TOKENS,
  TIP20_ABI,
  TIP20_DECIMALS
} from '../shared/config'
import {
  EIP1193_ERROR_CODES,
  invalidParams,
  toProviderError,
  unauthorized,
  unsupported,
  userRejected
} from '../shared/errors'
import type {
  ApprovalRequest,
  BackgroundRequest,
  BackgroundResponse,
  ConnectionMap,
  PopupState,
  ProviderRequest,
  ProviderResponse,
  VaultData,
  VaultRecord
} from '../shared/types'
import { encryptVault, decryptVault } from '../shared/vault'

const TIP20_INTERFACE = new Interface(TIP20_ABI)

const STORAGE_KEYS = {
  vault: 'vault',
  feeToken: 'feeToken',
  connections: 'connections',
  autoLockMinutes: 'autoLockMinutes',
  selectedAccountIndex: 'selectedAccountIndex',
  lastActivity: 'lastActivity'
} as const

const DEFAULT_AUTO_LOCK_MINUTES = 5

let unlockedVault: VaultData | null = null
let cachedAddress: string | null = null
let cachedAccountIndex: number | null = null
let vaultPassword: string | null = null
let lastApprovalWindowId: number | null = null

const pendingApprovals = new Map<
  string,
  {
    request: ApprovalRequest
    resolve: (approved: boolean) => void
    windowId?: number
  }
>()

async function storageGet<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key)
  return result[key] as T | undefined
}

async function storageSet(values: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(values)
}

async function getSelectedAccountIndex(): Promise<number> {
  const stored = await storageGet<number>(STORAGE_KEYS.selectedAccountIndex)
  return typeof stored === 'number' ? stored : 0
}

async function setSelectedAccountIndex(index: number): Promise<void> {
  await storageSet({ [STORAGE_KEYS.selectedAccountIndex]: index })
}

async function touchActivity(): Promise<void> {
  await storageSet({ [STORAGE_KEYS.lastActivity]: Date.now() })
}

async function isAutoLocked(): Promise<boolean> {
  const [autoLockMinutes, lastActivity] = await Promise.all([
    storageGet<number>(STORAGE_KEYS.autoLockMinutes),
    storageGet<number>(STORAGE_KEYS.lastActivity)
  ])
  const minutes = autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES
  if (!lastActivity || minutes <= 0) return false
  return Date.now() - lastActivity > minutes * 60 * 1000
}

async function ensureUnlocked(): Promise<VaultData> {
  if (await isAutoLocked()) {
    await lockVault()
  }
  if (!unlockedVault) {
    throw unauthorized()
  }
  await touchActivity()
  return unlockedVault
}

async function lockVault(): Promise<void> {
  unlockedVault = null
  cachedAddress = null
  cachedAccountIndex = null
  vaultPassword = null
  await storageSet({ [STORAGE_KEYS.lastActivity]: 0 })
}

async function getVaultRecord(): Promise<VaultRecord | undefined> {
  return storageGet<VaultRecord>(STORAGE_KEYS.vault)
}

async function rpcRequest<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(TEMPO_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  })
  const payload = await response.json()
  if (payload.error) {
    throw new Error(payload.error.message || 'RPC error')
  }
  return payload.result as T
}

function parseHexToBigInt(value: string): bigint {
  return BigInt(value)
}

function isInsufficientFundsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.toLowerCase().includes('insufficient funds')
}

function formatFeeTokenAmount(value: bigint): string {
  return formatUnits(value, TIP20_DECIMALS)
}

async function getFeeTokenBalance(
  tokenAddress: string,
  account: string
): Promise<string | undefined> {
  try {
    const data = TIP20_INTERFACE.encodeFunctionData('balanceOf', [account])
    const balanceHex = await rpcRequest<string>('eth_call', [{ to: tokenAddress, data }, 'latest'])
    return formatUnits(parseHexToBigInt(balanceHex), TIP20_DECIMALS)
  } catch (_error) {
    return undefined
  }
}

function buildApprovalSummary(kind: ApprovalRequest['kind']): string {
  switch (kind) {
    case 'connect':
      return 'Connect request'
    case 'sign_message':
      return 'Sign message'
    case 'sign_typed_data':
      return 'Sign typed data'
    case 'send_transaction':
      return 'Send Tempo transaction'
    default:
      return 'Request'
  }
}

function decodeMemo(memo: string): string {
  const bytes = getBytes(memo)
  const printable = bytes.every((b) => b === 0 || (b >= 32 && b <= 126))
  if (!printable) return memo
  const text = new TextDecoder().decode(bytes).replace(/\0+$/u, '')
  return text.length > 0 ? text : memo
}

function decodeTransactionIntent(to: string, data: string, value: bigint): Record<string, string> {
  const details: Record<string, string> = {
    to: to,
    value: value > 0n ? formatUnits(value, 18) : '0'
  }

  try {
    const parsed = TIP20_INTERFACE.parseTransaction({ data })
    if (parsed?.name === 'transfer' || parsed?.name === 'transferWithMemo') {
      const [recipient, amount, memo] = parsed.args
      details.token = to
      details.recipient = recipient
      details.amount = formatUnits(amount, TIP20_DECIMALS)
      if (memo) {
        details.memo = decodeMemo(hexlify(memo))
      }
      details.method = parsed.name
    }
  } catch (_error) {
    details.method = data !== '0x' ? 'contract_call' : 'transfer'
  }

  return details
}

async function requestApproval(request: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(request.id, { request, resolve })
    const url = chrome.runtime.getURL(`approval.html?requestId=${request.id}`)
    chrome.windows.create(
      { url, type: 'popup', width: 420, height: 640 },
      (window) => {
        if (!window?.id) return
        pendingApprovals.set(request.id, {
          request,
          resolve,
          windowId: window.id
        })
        lastApprovalWindowId = window.id
      }
    )
  })
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pendingApprovals.entries()) {
    if (entry.windowId === windowId) {
      pendingApprovals.delete(id)
      entry.resolve(false)
    }
  }
  if (lastApprovalWindowId === windowId) {
    lastApprovalWindowId = null
  }
})

async function getConnections(): Promise<ConnectionMap> {
  return (await storageGet<ConnectionMap>(STORAGE_KEYS.connections)) ?? {}
}

async function setConnection(origin: string, accounts: string[]): Promise<void> {
  const connections = await getConnections()
  connections[origin] = {
    allowedAccounts: accounts,
    lastConnectedAt: Date.now()
  }
  await storageSet({ [STORAGE_KEYS.connections]: connections })
}

async function getConnectedAccounts(origin: string): Promise<string[]> {
  const connections = await getConnections()
  return connections[origin]?.allowedAccounts ?? []
}

async function getFeeToken(): Promise<string> {
  return (await storageGet<string>(STORAGE_KEYS.feeToken)) ?? DEFAULT_FEE_TOKEN
}

async function setFeeToken(feeToken: string): Promise<void> {
  await storageSet({ [STORAGE_KEYS.feeToken]: feeToken })
}

async function buildTempoTx(
  from: string,
  to: string,
  data: string,
  value: string | undefined,
  feeToken: string
): Promise<{ rawTx: string; estimatedFee: string; feeToken: string }> {
  let resolvedFeeToken = getAddress(feeToken)
  const normalizedDefaultFeeToken = DEFAULT_FEE_TOKEN.toLowerCase()
  const normalizedTo = to.toLowerCase()
  if (
    resolvedFeeToken.toLowerCase() === normalizedDefaultFeeToken &&
    normalizedTo.startsWith('0x20c0') &&
    normalizedTo !== normalizedDefaultFeeToken
  ) {
    try {
      const balanceOfData = TIP20_INTERFACE.encodeFunctionData('balanceOf', [from])
      const feeTokenBalanceHex = await rpcRequest<string>('eth_call', [
        { to: resolvedFeeToken, data: balanceOfData },
        'latest'
      ])
      if (parseHexToBigInt(feeTokenBalanceHex) === 0n) {
        const toTokenBalanceHex = await rpcRequest<string>('eth_call', [
          { to: getAddress(to), data: balanceOfData },
          'latest'
        ])
        if (parseHexToBigInt(toTokenBalanceHex) > 0n) {
          resolvedFeeToken = getAddress(to)
        }
      }
    } catch (_error) {
      resolvedFeeToken = getAddress(feeToken)
    }
  }

  const noncePromise = rpcRequest<string>('eth_getTransactionCount', [from, 'latest'])
  const gasPricePromise = rpcRequest<string>('eth_gasPrice')
  const estimateParams = { from, to, data, value: value ?? '0x0' }
  const gasEstimatePromise = rpcRequest<string>('eth_estimateGas', [estimateParams]).catch(
    async (error) => {
      if (!isInsufficientFundsError(error)) {
        throw error
      }
      return rpcRequest<string>('eth_estimateGas', [
        {
          ...estimateParams,
          maxFeePerGas: '0x0',
          maxPriorityFeePerGas: '0x0'
        }
      ])
    }
  )
  const [nonceHex, gasEstimateHex, gasPriceHex] = await Promise.all([
    noncePromise,
    gasEstimatePromise,
    gasPricePromise
  ])
  const priorityFeeHex = await rpcRequest<string>('eth_maxPriorityFeePerGas').catch(() => gasPriceHex)

  const nonce = parseHexToBigInt(nonceHex)
  const gasEstimate = parseHexToBigInt(gasEstimateHex)
  const gasLimit = gasEstimate + gasEstimate / 5n + 1_000n
  const feeEstimatePerGas = parseHexToBigInt(gasPriceHex)
  const maxFeePerGas = feeEstimatePerGas
  const maxPriorityFeePerGas = parseHexToBigInt(priorityFeeHex)
  const call = {
    to: getAddress(to),
    value: value ? parseHexToBigInt(value) : 0n,
    input: data ?? '0x'
  }

  const txRequest = {
    chainId: TEMPO_CHAIN_ID,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gas: gasLimit,
    calls: [
      {
        to: call.to,
        value: call.value,
        data: call.input
      }
    ],
    nonce,
    feeToken: resolvedFeeToken,
    type: 'tempo' as const
  }

  const vault = await ensureUnlocked()
  const index = await getSelectedAccountIndex()
  const selectedAccount = vault.accounts[index] ?? vault.accounts[0]
  if (!selectedAccount) {
    throw unauthorized('No account available')
  }
  const account = privateKeyToAccount(selectedAccount.privateKey as `0x${string}`)
  const rawTx = await account.signTransaction(txRequest, {
    serializer: Transaction.serialize
  })

  const estimatedFee = formatFeeTokenAmount(
    (gasLimit * feeEstimatePerGas + 999_999_999_999n) / 1_000_000_000_000n
  )

  return { rawTx, estimatedFee, feeToken: resolvedFeeToken }
}

async function getSigner(): Promise<Wallet> {
  const vault = await ensureUnlocked()
  const index = await getSelectedAccountIndex()
  const account = vault.accounts[index] ?? vault.accounts[0]
  if (!account) {
    throw unauthorized('No account available')
  }
  return new Wallet(account.privateKey)
}

async function getPrimaryAddress(): Promise<string | null> {
  const index = await getSelectedAccountIndex()
  if (cachedAddress && cachedAccountIndex === index) return cachedAddress
  if (!unlockedVault) return null
  cachedAddress = unlockedVault.accounts[index]?.address ?? unlockedVault.accounts[0]?.address ?? null
  cachedAccountIndex = index
  return cachedAddress
}

async function handleProviderRequest(payload: ProviderRequest): Promise<ProviderResponse> {
  try {
    const { method, params = [], origin } = payload
    if (unlockedVault) {
      await touchActivity()
    }

    if (method === 'eth_chainId') {
      return { id: payload.id, result: TEMPO_CHAIN_ID_HEX }
    }

    if (method === 'net_version') {
      return { id: payload.id, result: TEMPO_CHAIN_ID.toString() }
    }

    if (method === 'eth_accounts') {
      const accounts = await getConnectedAccounts(origin)
      return { id: payload.id, result: accounts }
    }

    if (method === 'eth_requestAccounts') {
      await ensureUnlocked()
      const account = await getPrimaryAddress()
      if (!account) throw unauthorized('No account available')

      const approvalId = crypto.randomUUID()
      const approval: ApprovalRequest = {
        id: approvalId,
        kind: 'connect',
        origin,
        account,
        createdAt: Date.now(),
        summary: buildApprovalSummary('connect'),
        details: { origin, account }
      }
      const approved = await requestApproval(approval)
      if (!approved) throw userRejected()
      await setConnection(origin, [account])
      return { id: payload.id, result: [account] }
    }

    if (method === 'personal_sign') {
      let [message, accountParam] = params as [string, string]
      let account: string
      try {
        account = getAddress(accountParam)
      } catch (_error) {
        account = getAddress(message)
        message = accountParam
      }
      await ensureUnlocked()

      const connected = await getConnectedAccounts(origin)
      if (!connected.includes(account)) throw unauthorized('Account not connected')

      const approvalId = crypto.randomUUID()
      const decoded = isHexString(message) ? new TextDecoder().decode(getBytes(message)) : message
      const approval: ApprovalRequest = {
        id: approvalId,
        kind: 'sign_message',
        origin,
        account,
        createdAt: Date.now(),
        summary: buildApprovalSummary('sign_message'),
        details: { message: decoded }
      }
      const approved = await requestApproval(approval)
      if (!approved) throw userRejected()

      const wallet = await getSigner()
      const signature = await wallet.signMessage(isHexString(message) ? getBytes(message) : message)
      return { id: payload.id, result: signature }
    }

    if (method === 'eth_signTypedData_v4') {
      const [first, second] = params as [string, string]
      let account: string
      let typedData: string
      try {
        account = getAddress(first)
        typedData = second
      } catch (_error) {
        account = getAddress(second)
        typedData = first
      }
      await ensureUnlocked()

      const connected = await getConnectedAccounts(origin)
      if (!connected.includes(account)) throw unauthorized('Account not connected')

      const parsed = JSON.parse(typedData) as {
        domain: Record<string, unknown>
        types: Record<string, Array<{ name: string; type: string }>>
        message: Record<string, unknown>
        primaryType: string
      }

      const approvalId = crypto.randomUUID()
      const approval: ApprovalRequest = {
        id: approvalId,
        kind: 'sign_typed_data',
        origin,
        account,
        createdAt: Date.now(),
        summary: buildApprovalSummary('sign_typed_data'),
        details: {
          domain: JSON.stringify(parsed.domain),
          primaryType: parsed.primaryType
        }
      }
      const approved = await requestApproval(approval)
      if (!approved) throw userRejected()

      const wallet = await getSigner()
      const signature = await wallet.signTypedData(parsed.domain, parsed.types, parsed.message)
      return { id: payload.id, result: signature }
    }

    if (method === 'eth_sendTransaction') {
      const [txRequest] = params as Array<Record<string, string | undefined>>
      if (!txRequest?.from || !txRequest.to) throw invalidParams('Missing from or to')
      const from = getAddress(txRequest.from)
      const account = await getPrimaryAddress()
      if (!account || account.toLowerCase() !== from.toLowerCase()) {
        throw unauthorized('Account not connected')
      }

      await ensureUnlocked()
      const connected = await getConnectedAccounts(origin)
      if (!connected.includes(account)) throw unauthorized('Account not connected')

      const feeToken = isHexString(String(txRequest.feeToken ?? ''), 20)
        ? (txRequest.feeToken as string)
        : await getFeeToken()

      const data = txRequest.data ?? '0x'
      const value = txRequest.value
      const { rawTx, estimatedFee, feeToken: resolvedFeeToken } = await buildTempoTx(
        from,
        txRequest.to,
        data,
        value,
        feeToken
      )
      const feeTokenBalance = await getFeeTokenBalance(resolvedFeeToken, from)

      const approvalId = crypto.randomUUID()
      const approval: ApprovalRequest = {
        id: approvalId,
        kind: 'send_transaction',
        origin,
        account,
        createdAt: Date.now(),
        summary: buildApprovalSummary('send_transaction'),
        details: decodeTransactionIntent(txRequest.to, data, value ? parseHexToBigInt(value) : 0n),
        feeToken: resolvedFeeToken,
        estimatedFee,
        feeTokenBalance
      }
      const approved = await requestApproval(approval)
      if (!approved) throw userRejected()

      const txHash = await rpcRequest<string>('eth_sendRawTransaction', [rawTx])
      return { id: payload.id, result: txHash }
    }

    if (method === 'eth_getBalance' || method === 'eth_call') {
      const result = await rpcRequest(method, params)
      return { id: payload.id, result }
    }

    throw unsupported()
  } catch (error) {
    return { id: payload.id, error: toProviderError(error) }
  }
}

async function handleUiRequest(action: BackgroundRequest & { type: 'UI_REQUEST' }): Promise<BackgroundResponse> {
  try {
    switch (action.action) {
      case 'GET_STATE': {
        if (unlockedVault) {
          await touchActivity()
        }
        const vault = await getVaultRecord()
        const feeToken = await getFeeToken()
        const connections = await getConnections()
        const autoLockMinutes = (await storageGet<number>(STORAGE_KEYS.autoLockMinutes)) ??
          DEFAULT_AUTO_LOCK_MINUTES
        const locked = !unlockedVault
        let selectedIndex = await getSelectedAccountIndex()
        let address: string | undefined
        let feeTokenBalance: string | undefined
        let tokenBalances: Record<string, string> | undefined
        let totalBalance: string | undefined
        let accounts: string[] | undefined
        if (unlockedVault) {
          if (selectedIndex < 0 || selectedIndex >= unlockedVault.accounts.length) {
            selectedIndex = 0
            await setSelectedAccountIndex(selectedIndex)
          }
          accounts = unlockedVault.accounts.map((account) => account.address)
          address = await getPrimaryAddress()
          if (address) {
            const data = TIP20_INTERFACE.encodeFunctionData('balanceOf', [address])
            const balanceHex = await rpcRequest<string>('eth_call', [
              { to: feeToken, data },
              'latest'
            ])
            feeTokenBalance = formatUnits(parseHexToBigInt(balanceHex), TIP20_DECIMALS)

            const balances = await Promise.all(
              TEMPO_TOKENS.map(async (token) => {
                const tokenBalanceHex = await rpcRequest<string>('eth_call', [
                  { to: token.address, data },
                  'latest'
                ])
                return {
                  symbol: token.symbol,
                  balance: parseHexToBigInt(tokenBalanceHex)
                }
              })
            )
            tokenBalances = balances.reduce<Record<string, string>>((acc, item) => {
              acc[item.symbol] = formatUnits(item.balance, TIP20_DECIMALS)
              return acc
            }, {})
            const total = balances.reduce((acc, item) => acc + item.balance, 0n)
            totalBalance = formatUnits(total, TIP20_DECIMALS)
          }
        }
        const state: PopupState = {
          hasVault: Boolean(vault),
          locked,
          address,
          accounts,
          selectedAccount: address,
          feeToken,
          feeTokenBalance,
          tokenBalances,
          totalBalance,
          connections,
          autoLockMinutes,
          rpcUrl: TEMPO_RPC_URL
        }
        return { ok: true, result: state }
      }
      case 'GET_PRIVATE_KEY': {
        const vault = await ensureUnlocked()
        const index = await getSelectedAccountIndex()
        const account = vault.accounts[index] ?? vault.accounts[0]
        if (!account) throw unauthorized('No account available')
        await touchActivity()
        return { ok: true, result: { privateKey: account.privateKey } }
      }
      case 'CREATE_WALLET_START': {
        const wallet = Wallet.createRandom()
        const mnemonic = wallet.mnemonic?.phrase ?? ''
        unlockedVault = {
          accounts: [{ address: wallet.address, privateKey: wallet.privateKey }],
          mnemonic
        }
        cachedAddress = wallet.address
        await touchActivity()
        return { ok: true, result: { mnemonic, address: wallet.address } }
      }
      case 'CREATE_WALLET_FINISH': {
        const { password, mnemonic } = action.payload as { password: string; mnemonic: string }
        if (!password || !mnemonic) throw invalidParams('Missing password or mnemonic')
        const wallet = Wallet.fromPhrase(mnemonic)
        const vault: VaultData = {
          accounts: [{ address: wallet.address, privateKey: wallet.privateKey }],
          mnemonic
        }
        const record = await encryptVault(password, vault)
        await storageSet({
          [STORAGE_KEYS.vault]: record,
          [STORAGE_KEYS.feeToken]: DEFAULT_FEE_TOKEN,
          [STORAGE_KEYS.autoLockMinutes]: DEFAULT_AUTO_LOCK_MINUTES,
          [STORAGE_KEYS.selectedAccountIndex]: 0
        })
        unlockedVault = vault
        cachedAddress = wallet.address
        cachedAccountIndex = 0
        vaultPassword = password
        await touchActivity()
        return { ok: true, result: { address: wallet.address } }
      }
      case 'IMPORT_WALLET': {
        const { password, phraseOrKey } = action.payload as { password: string; phraseOrKey: string }
        if (!password || !phraseOrKey) throw invalidParams('Missing password or key')
        const trimmed = phraseOrKey.trim()
        const wallet = trimmed.split(' ').length > 1 ? Wallet.fromPhrase(trimmed) : new Wallet(trimmed)
        const vault: VaultData = {
          accounts: [{ address: wallet.address, privateKey: wallet.privateKey }],
          mnemonic: wallet.mnemonic?.phrase
        }
        const record = await encryptVault(password, vault)
        await storageSet({
          [STORAGE_KEYS.vault]: record,
          [STORAGE_KEYS.feeToken]: DEFAULT_FEE_TOKEN,
          [STORAGE_KEYS.autoLockMinutes]: DEFAULT_AUTO_LOCK_MINUTES,
          [STORAGE_KEYS.selectedAccountIndex]: 0
        })
        unlockedVault = vault
        cachedAddress = wallet.address
        cachedAccountIndex = 0
        vaultPassword = password
        await touchActivity()
        return { ok: true, result: { address: wallet.address } }
      }
      case 'UNLOCK': {
        const { password } = action.payload as { password: string }
        const record = await getVaultRecord()
        if (!record) throw unauthorized('No vault found')
        unlockedVault = await decryptVault(password, record)
        const index = await getSelectedAccountIndex()
        cachedAddress = unlockedVault.accounts[index]?.address ?? unlockedVault.accounts[0]?.address ?? null
        cachedAccountIndex = index
        vaultPassword = password
        await touchActivity()
        return { ok: true, result: { address: cachedAddress } }
      }
      case 'LOCK': {
        await lockVault()
        return { ok: true }
      }
      case 'SET_AUTO_LOCK': {
        const { minutes } = action.payload as { minutes: number }
        await storageSet({ [STORAGE_KEYS.autoLockMinutes]: minutes })
        if (unlockedVault) {
          await touchActivity()
        }
        return { ok: true }
      }
      case 'SET_FEE_TOKEN': {
        const { feeToken } = action.payload as { feeToken: string }
        await setFeeToken(getAddress(feeToken))
        if (unlockedVault) {
          await touchActivity()
        }
        return { ok: true }
      }
      case 'SET_ACTIVE_ACCOUNT': {
        const vault = await ensureUnlocked()
        const { address } = action.payload as { address: string }
        const index = vault.accounts.findIndex(
          (account) => account.address.toLowerCase() === address.toLowerCase()
        )
        if (index < 0) throw invalidParams('Unknown account')
        await setSelectedAccountIndex(index)
        cachedAddress = vault.accounts[index].address
        cachedAccountIndex = index
        await touchActivity()
        return { ok: true, result: { address: cachedAddress } }
      }
      case 'ADD_WALLET': {
        const vault = await ensureUnlocked()
        if (!vaultPassword) throw unauthorized('Missing session password')
        const wallet = Wallet.createRandom()
        vault.accounts.push({ address: wallet.address, privateKey: wallet.privateKey })
        const record = await encryptVault(vaultPassword, vault)
        await storageSet({ [STORAGE_KEYS.vault]: record })
        const newIndex = vault.accounts.length - 1
        await setSelectedAccountIndex(newIndex)
        unlockedVault = vault
        cachedAddress = wallet.address
        cachedAccountIndex = newIndex
        await touchActivity()
        return { ok: true, result: { address: wallet.address } }
      }
      case 'SEND_TIP20_PREPARE': {
        const vault = await ensureUnlocked()
        const index = await getSelectedAccountIndex()
        const account = vault.accounts[index] ?? vault.accounts[0]
        if (!account) throw unauthorized('No account available')
        const { token, recipient, amount, memo, feeToken: requestedFeeToken } = action.payload as {
          token: string
          recipient: string
          amount: string
          memo?: string
          feeToken?: string
        }
        const feeToken = isHexString(String(requestedFeeToken ?? ''), 20)
          ? getAddress(requestedFeeToken as string)
          : await getFeeToken()
        const memoBytes = memo ? encodeBytes32String(memo) : null
        const data = memo
          ? TIP20_INTERFACE.encodeFunctionData('transferWithMemo', [
              getAddress(recipient),
              parseUnits(amount, TIP20_DECIMALS),
              memoBytes
            ])
          : TIP20_INTERFACE.encodeFunctionData('transfer', [
              getAddress(recipient),
              parseUnits(amount, TIP20_DECIMALS)
            ])

        const { rawTx, estimatedFee, feeToken: resolvedFeeToken } = await buildTempoTx(
          account.address,
          getAddress(token),
          data,
          '0x0',
          feeToken
        )
        const feeTokenBalance = await getFeeTokenBalance(resolvedFeeToken, account.address)

        const approval: ApprovalRequest = {
          id: crypto.randomUUID(),
          kind: 'send_transaction',
          origin: 'popup',
          account: account.address,
          createdAt: Date.now(),
          summary: buildApprovalSummary('send_transaction'),
          details: decodeTransactionIntent(getAddress(token), data, 0n),
          feeToken: resolvedFeeToken,
          estimatedFee,
          feeTokenBalance
        }

        return { ok: true, result: { approval, rawTx } }
      }
      case 'SEND_TIP20_EXECUTE': {
        const { rawTx } = action.payload as { rawTx: string }
        if (!rawTx) throw invalidParams('Missing raw transaction')
        const txHash = await rpcRequest<string>('eth_sendRawTransaction', [rawTx])
        return { ok: true, result: { txHash } }
      }
      default:
        return { ok: false, error: { code: EIP1193_ERROR_CODES.unsupported, message: 'Unknown action' } }
    }
  } catch (error) {
    return { ok: false, error: toProviderError(error) }
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  if (message.type === 'PROVIDER_REQUEST') {
    handleProviderRequest(message.payload)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({
        id: message.payload.id,
        error: toProviderError(error)
      }))
    return true
  }

  if (message.type === 'UI_REQUEST') {
    handleUiRequest(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: toProviderError(error) }))
    return true
  }

  if (message.type === 'APPROVAL_GET') {
    const entry = pendingApprovals.get(message.requestId)
    if (!entry) {
      sendResponse({ ok: false, error: { code: EIP1193_ERROR_CODES.invalidParams, message: 'Unknown request' } })
      return false
    }
    sendResponse({ ok: true, result: entry.request })
    return false
  }

  if (message.type === 'APPROVAL_RESPONSE') {
    const entry = pendingApprovals.get(message.requestId)
    if (entry) {
      pendingApprovals.delete(message.requestId)
      entry.resolve(message.approved)
    }
    sendResponse({ ok: true })
    return false
  }

  return false
})
