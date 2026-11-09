# ArusPay — Arc Testnet Invoice Preview

A responsive invoice workflow connected to the deployed `ArusPayInvoices` contract on Arc Testnet. The preview is intentionally testnet-only; it does not configure Arc Mainnet.

## Arc Testnet configuration

- Chain ID: `5042002`
- Browser RPC default: `https://rpc.blockdaemon.testnet.arc.io` (an Arc-documented Testnet provider with browser CORS support)
- Arc primary RPC: `https://rpc.testnet.arc.io`
- Explorer: `https://explorer.testnet.arc.io`
- Deployed invoice contract: `0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926`
- Native gas and payment asset: USDC with 18 decimal places

Privy is configured with Arc Testnet as its default and only supported EVM chain in this preview. The invoice module also checks the connected provider's chain ID before signing and will only add or switch to Arc Testnet.

## Run locally

Use Node.js 18 or newer:

```bash
npm install
npm run dev
```

For a remote preview, set `ARUSPAY_PREVIEW_HOST` to the exact preview hostname before starting Vite. It is not needed for localhost.

To build and serve a production preview:

```bash
npm run build
npm run preview
```

Copy `.env.example` to `.env` for local setup. Vite variables are public client configuration only; never put a Supabase service-role key, wallet private key, or other secret in a `VITE_` variable.

## Invoice and payment flow

- `createInvoice(bytes32,uint256,uint64)` records the merchant, exact native-USDC amount, and expiry on Arc Testnet. Invoice IDs are random opaque values and do not contain client information.
- The app validates a confirmed `InvoiceCreated` receipt/event before showing an invoice as created.
- Browser requests default to Arc's documented Blockdaemon Testnet endpoint because the primary Testnet RPC blocks CORS requests from Vercel preview origins; `VITE_ARUSPAY_BROWSER_RPC_URL` can override this transport without changing the chain or contract.
- The dashboard reads the connected Privy wallet's native USDC balance with `eth_getBalance` (18 decimals), and syncs the wallet's invoice events from the contract deployment block in ranges below Arc's 10,000-block `eth_getLogs` limit. It then reads each invoice's current contract state. Refreshing is read-only and submits no transaction.
- `Total received` and `Confirmed payments` include only invoices whose current contract state is `Paid` and whose matching `InvoicePaid` event has the exact amount and merchant. A faucet balance appears only under `Wallet balance`; it is not revenue.
- A payment link contains only the merchant address and invoice ID. Client name, email, description, and note remain off-chain in the current browser session; no email or backend delivery is configured.
- `payInvoice(address,bytes32)` submits the exact invoice value as native USDC. The app validates the successful receipt and matching `InvoicePaid` event, then checks the contract state before showing the invoice as paid.
- The connected wallet pays its own Arc Testnet USDC gas fees. No gas sponsorship, relayer, or token approval is used.
- Payment state is read from Arc Testnet; a wallet prompt or local record alone is never treated as proof of payment.

## Profile and wallet recovery

- The Profile page uses the authenticated Privy user and linked accounts returned by Privy. It shows a wallet address only when Privy returns an embedded EVM wallet; the address can be copied from the page.
- X/Twitter linking uses Privy's authenticated-user account-link flow. It links X to the current Privy user rather than starting a new sign-in flow.
- Display names are synced through the `aruspay-api` Supabase Edge Function. The function verifies the Privy access-token signature and claims, then reads or updates only the profile row whose ID matches the verified Privy subject. Legacy browser-only names are migrated only after the server confirms the save.
- Supabase tables keep row-level security enabled without browser-access policies. The service-role key is used only by the Edge Function at runtime and must never be added to Vercel client variables, browser code, or source control.
- Private-key export is started only after the user confirms an on-screen safety warning, then handled by Privy's own export modal. ArusPay does not retrieve, receive, log, or store the private key. Anyone who obtains the key can control the wallet.
- The profile flow performs no on-chain transactions.

Run the safe profile smoke test with `npm run test:profile`. It exercises the UI in isolated JSDOM fixtures with mocked API responses, including cloud profile read/write, account isolation, legacy-name migration, failed-save handling, copy actions, X-link gating, key-export confirmation/cancel, and empty states. It does not authenticate a real user, reveal a private key, or send transactions. Live X authorization, profile sync, and the Privy export modal should be verified from the account owner's own signed-in session.

The preview should remain testnet-only until a separate, explicit mainnet launch decision and production review.

## Real Arc Testnet integration test

The test harness uses Node.js 22 or newer, Arc Foundry's `arc-cast`, and an encrypted testnet keystore. It exercises the actual frontend create/pay handlers with a restricted EIP-1193 signer adapter. The adapter permits only one `createInvoice` and one exact 0.10-USDC `payInvoice` call to the configured contract on chain `5042002`; signing stays in `arc-cast`, so no private key enters the DOM or frontend bundle.

Before running the harness, build the local contract artifact from the reviewed source:

```bash
(cd contracts && forge build)
```

```bash
ARUSPAY_TEST_KEYSTORE=/secure/path/to/testnet-keystore \
ARUSPAY_TEST_PASSWORD_FILE=/secure/path/to/password-file \
ARUSPAY_E2E_RESULT=/tmp/aruspay-testnet-e2e-result.json \
ARUSPAY_PREVIEW_URL=http://localhost:4173/ \
npm run test:testnet
```

This command sends real Arc Testnet transactions and uses the same test wallet as merchant and payer. It verifies the deployed bytecode, successful receipts, matching `InvoiceCreated` and `InvoicePaid` events, exact payment value, and final `Paid` contract state. Explicit test metadata exists only in the harness DOM and is never seeded into the normal preview.

A result with submitted transactions blocks a blind rerun. Inspect the saved public transaction hashes first, then choose a new result path only when a new test is intended. The harness does not automate Privy authentication or a browser wallet's confirmation UI; inspect the public payment-link view in the browser separately.
