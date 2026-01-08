export const TEMPO_CHAIN_ID = 42431
export const TEMPO_CHAIN_ID_HEX = '0xa5bf'
export const TEMPO_CHAIN_NAME = 'Tempo Testnet (Andantino)'
export const TEMPO_RPC_URL = 'https://rpc.moderato.tempo.xyz'
export const TEMPO_EXPLORER_URL = 'https://explore.tempo.xyz'

export const TEMPO_TX_TYPE = 0x76

export const TIP20_DECIMALS = 6
export const DEFAULT_FEE_TOKEN = '0x20c0000000000000000000000000000000000001'

export const TEMPO_TOKENS = [
  { symbol: 'PathUSD', address: '0x20c0000000000000000000000000000000000000' },
  { symbol: 'AlphaUSD', address: '0x20c0000000000000000000000000000000000001' },
  { symbol: 'BetaUSD', address: '0x20c0000000000000000000000000000000000002' },
  { symbol: 'ThetaUSD', address: '0x20c0000000000000000000000000000000000003' }
] as const

export const TIP20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferWithMemo(address to, uint256 amount, bytes32 memo)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
]
