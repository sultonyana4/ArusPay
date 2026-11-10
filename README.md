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

Use localhost for development checks. Publish validated changes from `main` only to the fixed production domain `https://aruspay-pi.vercel.app`; do not create hosted preview deployments.

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
- A payment link contains only the merchant address and invoice ID. Invoice recipient name, email, description, and due date are off-chain metadata stored in Supabase after the app verifies the successful `InvoiceCreated` receipt and event.
- `payInvoice(address,bytes32)` submits the exact invoice value as native USDC. The app validates the successful receipt and matching `InvoicePaid` event, then checks the contract state before showing the invoice as paid.
- The connected wallet pays its own Arc Testnet USDC gas fees. No gas sponsorship, relayer, or token approval is used.
- Payment status is read from Arc Testnet; Supabase metadata, a wallet prompt, and any reported transaction hash are never treated as proof of payment.
- A Privy linked wallet address is not treated as a connected signing provider. The app waits for Privy's `useWallets` readiness and checks the selected EIP-1193 provider with a read-only `eth_chainId` request; this confirms provider connectivity only, not signing capability.

## Supabase metadata and access

- The existing `profiles` table stores each Privy user's display name. The existing `merchant_invoices` table stores off-chain invoice metadata, keyed to the invoice's Arc chain, contract, merchant, and ID. This metadata is written only after the app verifies contract creation; it never creates or pays an invoice.
- `payment_attempts` stores only a Privy-user-scoped, wallet-reported submission hint for reconciling an ambiguous payment. It has no payment-status field and is cleared when the app confirms a terminal result from Arc.
- Browser requests go through the `aruspay-api` Supabase Edge Function. It verifies the Privy ES256 access token and derives the `privy_user_id` from its verified `sub` claim. Before reading or storing invoice metadata, it also verifies a signed Privy identity token and confirms the merchant address is one of that user's linked wallets. Enable **Return user data in an identity token** in Privy under User management → Authentication → Advanced. The Supabase service-role key stays in Edge Function secrets and is never sent to the browser.
- RLS is enabled on the metadata tables with no direct browser policies. The function returns merchant invoice metadata only to the authenticated Privy owner. The payment-attempt table is isolated by the authenticated payer's Privy identity.
- The deployed Edge Function allows only the fixed production origin `https://aruspay-pi.vercel.app`; localhost and Vercel preview origins are not allowed. If Supabase is unavailable, Arc reads remain authoritative and the UI reports that cloud metadata could not be loaded or saved.

## Profile and wallet recovery

- The Profile page uses the authenticated Privy user and linked accounts returned by Privy. It shows a wallet address only when Privy returns an embedded EVM wallet; the address can be copied from the page.
- The Profile page also shows the authenticated wallet's live native-USDC balance and active address, using the same read-only Arc Testnet balance read as the dashboard; this is separate from invoice revenue.
- X/Twitter linking uses Privy's authenticated-user account-link flow. It links X to the current Privy user rather than starting a new sign-in flow.
- Display names are stored in Supabase, scoped to the authenticated Privy user, and sync across devices. They are not stored as durable ArusPay data in browser storage.
- Private-key export is started only after the user confirms an on-screen safety warning, then handled by Privy's own export modal. ArusPay does not retrieve, receive, log, or store the private key. Anyone who obtains the key can control the wallet.
- The profile flow performs no on-chain transactions.

Run the profile and metadata regressions with `npm run test:profile` and `npm run test:metadata`. They use isolated JSDOM fixtures and mocked Privy/Supabase calls to check cloud-backed display names, production-only CORS, input validation, access-token forwarding, signed wallet binding, user isolation, and the absence of app-owned local persistence. They do not authenticate a real user, test signing, reveal a private key, or send transactions. Live Privy connection, identity-token availability, X authorization, and the Privy export modal should be verified from the account owner's own signed-in session.

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
