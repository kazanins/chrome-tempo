export type ProviderRequest = {
  id: string
  method: string
  params?: unknown[]
  origin: string
}

export type ProviderResponse = {
  id: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type BackgroundRequest =
  | { type: 'PROVIDER_REQUEST'; payload: ProviderRequest }
  | { type: 'UI_REQUEST'; action: UIAction; payload?: unknown }
  | { type: 'POPUP_CLOSED' }
  | { type: 'APPROVAL_GET'; requestId: string }
  | { type: 'APPROVAL_RESPONSE'; requestId: string; approved: boolean; account?: string; feeToken?: string }

export type BackgroundResponse = {
  ok: boolean
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type UIAction =
  | 'GET_STATE'
  | 'GET_PENDING_APPROVAL'
  | 'GET_PRIVATE_KEY'
  | 'ADD_WALLET'
  | 'SET_ACTIVE_ACCOUNT'
  | 'CREATE_WALLET_START'
  | 'CREATE_WALLET_FINISH'
  | 'IMPORT_WALLET'
  | 'UNLOCK'
  | 'LOCK'
  | 'SET_AUTO_LOCK'
  | 'SET_FEE_TOKEN'
  | 'SEND_TIP20_PREPARE'
  | 'SEND_TIP20_EXECUTE'
  | 'GET_CUSTOM_TOKENS'
  | 'ADD_CUSTOM_TOKEN'
  | 'REMOVE_CUSTOM_TOKEN'
  | 'DISCONNECT_DAPP'

export type ApprovalKind =
  | 'connect'
  | 'sign_message'
  | 'sign_typed_data'
  | 'send_transaction'

export type ApprovalRequest = {
  id: string
  kind: ApprovalKind
  origin: string
  account: string
  accounts?: string[]
  createdAt: number
  summary: string
  details: Record<string, string>
  feeToken?: string
  estimatedFee?: string
  feeTokenBalance?: string
}

export type VaultData = {
  accounts: Array<{
    address: string
    privateKey: string
  }>
  mnemonic?: string
}

export type VaultRecord = {
  ciphertext: string
  iv: string
  salt: string
  iterations: number
  version: 1
}

export type CustomToken = {
  symbol: string
  address: string
}

export type ConnectionMap = Record<
  string,
  {
    allowedAccounts: string[]
    lastConnectedAt: number
  }
>

export type PopupState = {
  hasVault: boolean
  locked: boolean
  address?: string
  accounts?: string[]
  selectedAccount?: string
  feeToken?: string
  feeTokenBalance?: string
  tokenBalances?: Record<string, string>
  totalBalance?: string
  connections: ConnectionMap
  autoLockMinutes: number
  rpcUrl: string
  customTokens?: CustomToken[]
}
