# ArusPay — Arc Testnet Invoice App

A responsive invoice workflow connected to the deployed `ArusPayInvoices` contract on Arc Testnet. The application is intentionally testnet-only; it does not configure Arc Mainnet.

## Arc Testnet configuration

- Chain ID: `5042002`
- Browser RPC default: `https://rpc.blockdaemon.testnet.arc.io` (an Arc-documented Testnet provider with browser CORS support)
- Arc primary RPC: `https://rpc.testnet.arc.io`
- Explorer: `https://explorer.testnet.arc.io`
- Deployed invoice contract: `0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926`
- Native gas and payment asset: USDC with 18 decimal places

Privy is configured with Arc Testnet as its default and only supported EVM chain in this application. The invoice module also checks the connected provider's chain ID before signing and will only add or switch to Arc Testnet.

## Run locally

Use Node.js 18 or newer:

```bash
npm install
npm run dev
```

For a hosted development build, set `ARUSPAY_PREVIEW_HOST` to the exact host before starting Vite. It is not needed for localhost.

To build and serve a production bundle locally:

```bash
npm run build
npm run preview
```

Set `VITE_PRIVY_APP_ID` in a local `.env` file to override the public Privy app ID used by the prototype.

## Invoice and payment flow

- `createInvoice(bytes32,uint256,uint64)` records the merchant, exact native-USDC amount, and expiry on Arc Testnet. Invoice IDs are random opaque values and do not contain client information.
- Invoice creation, payment, and confirmed payment status use the deployed ArusPay contract only; there is no off-chain or contractless fallback.
- The app validates a confirmed `InvoiceCreated` receipt/event before showing an invoice as created.
- Browser requests default to Arc's documented Blockdaemon Testnet endpoint because the primary Testnet RPC blocks browser CORS requests, including from the existing production domain; `VITE_ARUSPAY_BROWSER_RPC_URL` can override this transport without changing the chain or contract.
- The dashboard reads the connected Privy wallet's native USDC balance with `eth_getBalance` (18 decimals), and syncs the wallet's invoice events from the contract deployment block in ranges below Arc's 10,000-block `eth_getLogs` limit. It then reads each invoice's current contract state. Refreshing is read-only and submits no transaction.
- `Total received` and `Confirmed payments` include only invoices whose current contract state is `Paid` and whose matching `InvoicePaid` event has the exact amount and merchant. A faucet balance appears only under `Wallet balance`; it is not revenue.
- A payment link contains only the merchant address and invoice ID. Client name, email, description, and note remain off-chain in the current browser session; no email or backend delivery is configured.
- `payInvoice(address,bytes32)` submits the exact invoice value as native USDC. The app validates the successful receipt and matching `InvoicePaid` event, then checks the contract state before showing the invoice as paid.
- The connected wallet pays its own Arc Testnet USDC gas fees. No gas sponsorship, relayer, or token approval is used.
- Payment state is read from Arc Testnet; a wallet prompt or local record alone is never treated as proof of payment.

## Profile and wallet recovery

- The Profile page uses the authenticated Privy user and linked accounts returned by Privy. It shows a wallet address only when Privy returns an embedded EVM wallet; the address can be copied from the page.
- The Profile page also shows the authenticated wallet's live native-USDC balance and active address, using the same read-only Arc Testnet balance read as the dashboard; this is separate from invoice revenue.
- X/Twitter linking uses Privy's authenticated-user account-link flow. It links X to the current Privy user rather than starting a new sign-in flow.
- Display names are stored in this browser's local storage, scoped to the Privy user ID. There is no backend profile service, so names are not synced to other browsers or devices.
- Private-key export is started only after the user confirms an on-screen safety warning, then handled by Privy's own export modal. ArusPay does not retrieve, receive, log, or store the private key. Anyone who obtains the key can control the wallet.
- The profile flow performs no on-chain transactions.

Run the safe profile smoke test with `npm run test:profile`. It exercises the UI in isolated JSDOM fixtures with mocked Privy methods, including account rendering, copy actions, local-only name storage, X-link gating, key-export confirmation/cancel, and empty states. It does not authenticate a real user, reveal a private key, or send transactions. Live X authorization and the Privy export modal should be verified from the account owner's own signed-in session.

The application must remain testnet-only until a separate, explicit mainnet launch decision and production review.

## Real Arc Testnet integration test

The test harness uses Node.js 22 or newer, Arc Foundry's `arc-cast`, and an encrypted testnet keystore. It exercises the actual frontend create/pay handlers with a restricted EIP-1193 signer adapter. The adapter permits only one `createInvoice` and one exact 0.10-USDC `payInvoice` call to the configured contract on chain `5042002`; signing stays in `arc-cast`, so no private key enters the DOM or frontend bundle.

Before running the harness, build the local contract artifact from the reviewed source:

```bash
(cd contracts && arc-forge build)
```

```bash
ARUSPAY_TEST_KEYSTORE=/secure/path/to/testnet-keystore \
ARUSPAY_TEST_PASSWORD_FILE=/secure/path/to/password-file \
ARUSPAY_E2E_RESULT=/tmp/aruspay-testnet-e2e-result.json \
npm run test:testnet
```

This command sends real Arc Testnet transactions and uses the same dedicated test wallet as merchant and payer. Its payment link uses the existing production domain. It verifies the deployed bytecode, successful receipts, matching `InvoiceCreated` and `InvoicePaid` events, exact payment value, and final `Paid` contract state. Explicit test metadata exists only in the harness DOM and is never seeded into the production app.

A result with submitted transactions blocks a blind rerun. Inspect the saved public transaction hashes first, then choose a new result path only when a new test is intended. The harness does not automate Privy authentication or a browser wallet's confirmation UI; inspect the public payment-link view in the browser separately.
