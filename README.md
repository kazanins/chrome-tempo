# Tempo Wallet (MV3)

Tempo Wallet is a Chrome extension (Manifest V3) that only works on the Tempo EVM chain.
It provides an EIP-1193 provider injection, a React popup UI, and a background service
worker that owns keys and signs Tempo Transactions (type 0x76).

## Features

- Tempo-only chain configuration (no network switching).
- EIP-1193 provider with `eth_requestAccounts`, `eth_accounts`, `eth_chainId`,
  `net_version`, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`,
  `eth_getBalance`, and `eth_call`.
- Approval windows for all signing/transaction requests, including decoded intent.
- TIP-20 fee token support with default fee token storage.
- Vault encryption using PBKDF2 + AES-GCM (WebCrypto).
- Auto-lock on inactivity.

## Architecture

- Injected provider: `src/injected/provider.ts`
- Content script bridge: `src/content_script.ts`
- Background service worker: `src/background/service_worker.ts`
- Shared types/errors/Tempo tx encoding: `src/shared/*`
- Popup UI: `src/popup/*`
- Approval UI: `src/approval/*`

## Tempo Transaction Encoding

Tempo Transactions follow the protocol specification:
- Typed transaction byte: `0x76` (EIP-2718)
- RLP envelope includes Tempo fields, fee token, optional fee payer signature, and
  sender signature bytes.
- Fee token is required for Tempo txs (Tempo has no native gas token).

Encoding and signing live in `src/shared/tempo.ts` and `src/background/service_worker.ts`.

## Build

```bash
npm install
npm run build
```

The extension output is in `dist/`.

## Load Unpacked

1. Open Chrome → Extensions.
2. Enable Developer Mode.
3. Click “Load unpacked”.
4. Select the `dist/` directory.

## Tests

```bash
npm test
```

## Security Notes

- Private keys never leave the background service worker.
- The vault is encrypted at rest using PBKDF2 (SHA-256) and AES-GCM.
- Per-origin connection approvals are stored in `chrome.storage.local`.

## Troubleshooting

- If the wallet is locked, you must unlock via the popup before signing or sending.
- If a dapp is not connected, use `eth_requestAccounts` to trigger approval.

