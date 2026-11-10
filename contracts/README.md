# ArusPay invoice contract on Arc Testnet

`ArusPayInvoices.sol` implements non-custodial invoice settlement using Arc's native-USDC interface. The ArusPay app is configured for the following Arc Testnet deployment:

- Chain ID: `5042002`
- RPC: `https://rpc.testnet.arc.io`
- Contract: `0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926`
- Explorer: `https://explorer.testnet.arc.io`

This project is testnet-only. It does not configure or authorize an Arc Mainnet deployment, and this source has not been independently security-audited.

## Payment flow

An invoice is identified by the pair `(merchant address, invoiceId)`. IDs are unique within each merchant's namespace. `createInvoice` always creates an invoice under `msg.sender`, so another address can use the same ID for its own invoice but cannot reserve or block the merchant's ID by front-running a creation transaction.

1. The merchant calls `createInvoice(invoiceId, amount, expiresAt)`. The caller becomes the merchant, and the invoice is stored under `(caller, invoiceId)`.
2. The payer checks the intended merchant address and calls `payInvoice(merchantAddress, invoiceId)` with exactly the invoice amount as native USDC (`msg.value`). The contract forwards the value directly to the merchant and emits `InvoicePaid` only if the transfer succeeds. A payment cannot be recorded twice.
3. The merchant may cancel an unpaid invoice with `cancelInvoice(merchantAddress, invoiceId)`. The contract has no owner/admin withdrawal method and does not intentionally hold invoice funds.

Clients and indexers must use the merchant address together with the invoice ID when calling `getInvoice` (or the generated `invoices` mapping getter), interpreting events, constructing payment links, and tracking status. A zero `expiresAt` means no expiry. Otherwise the invoice cannot be paid at or after that timestamp. Invoice descriptions, line items, customer details, and display currency remain off-chain; do not put personal information in the ID or public transaction data.

## Arc amount units and fees

Arc has a native USDC interface with 18 decimals for `msg.value` and gas, and an ERC-20 interface with 6 decimals at `0x3600000000000000000000000000000000000000`; both represent the same balance. This contract uses the native interface. Convert an amount entered to six decimal places into native units by multiplying by `10^12` (for example, 12.50 USDC is `12500000000000000000` native units). Use integer/`BigInt` arithmetic only; never convert payment values through JavaScript floating point.

The connected wallet pays its own Arc Testnet gas fees in USDC. No relayer or gas sponsor is used. Since payment is a payable native-value call, the payer does not need a separate ERC-20 approval transaction.

The UI checks the connected wallet is on Arc Testnet before offering a transaction, displays the amount, intended merchant, and estimated network fee before wallet confirmation, and accepts either the current `Paid` contract state or a successful receipt containing the exact `InvoicePaid` event and matching `payInvoice` transaction as payment proof. If an RPC state read still reports `Open` after event/receipt proof, the UI shows `Paid`, disables further payment, explains the RPC delay, and continues read-only checks until state catches up. Errors such as `already known` and `nonce too low` are treated as ambiguous; a wallet prompt or local invoice record alone is not proof, and the app never resubmits automatically.

## Test

Run the contract unit tests locally from this directory:

```sh
forge test
```

Foundry build output under `out/` and `cache/` is generated locally and is ignored by Git. The root README documents an optional Arc Testnet end-to-end harness; it requires an encrypted testnet keystore and sends real testnet transactions. Never store its keystore or password file in the repository. Do not run that harness unless you deliberately intend to make those testnet transactions.

For Arc-specific validation, use Arc Foundry's network option as described in the [official Arc deployment guide](https://docs.arc.network/arc/tutorials/deploy-on-arc). Testnet-only operation is intended here; no mainnet deployment is configured.

## Sources

- [Arc: Stablecoin native model](https://docs.arc.network/arc/concepts/stablecoin-native-model) — one USDC balance with native 18-decimal and ERC-20 6-decimal interfaces.
- [Arc: EVM compatibility](https://docs.arc.network/arc/references/evm-compatibility) — native value transfer rules and Arc-specific execution behavior.
- [Arc: Deploy on Arc](https://docs.arc.network/arc/tutorials/deploy-on-arc) — official test, deploy, and verify workflow.
