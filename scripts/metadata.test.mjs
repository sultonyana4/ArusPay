import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ARUSPAY_CONTRACT_ADDRESS,
  PRODUCTION_ORIGIN,
  identityTokenHasWallet,
  isAllowedOrigin,
  parseMerchantAddress,
  parseInvoicePayload,
  parseInvoiceLookup,
  parsePaymentAttemptPayload,
  parseProfilePayload,
} from '../supabase/functions/aruspay-api/domain.js';

const merchant = '0x1234567890abcdef1234567890abcdef12345678';
const invoiceId = `0x${'ab'.repeat(32)}`;
const txHash = `0x${'cd'.repeat(32)}`;
const subject = 'did:privy:metadata-test';

assert.equal(isAllowedOrigin('https://termul.xyz'), true);
assert.equal(isAllowedOrigin('https://termul-pay.vercel.app'), true);
assert.equal(isAllowedOrigin(PRODUCTION_ORIGIN), true, 'The legacy production origin remains allowed during migration.');
assert.equal(isAllowedOrigin('http://localhost:5173'), false);
assert.equal(isAllowedOrigin('https://aruspay-git-main-sultonyana4-8806s-projects.vercel.app'), false);
assert.equal(isAllowedOrigin('https://attacker.example'), false);
assert.equal(isAllowedOrigin('file:///tmp/app.html'), false);

assert.deepEqual(parseProfilePayload({ displayName: '  A. Merchant  ' }), { display_name: 'A. Merchant' });
assert.throws(() => parseProfilePayload({ displayName: ' ' }), /display name/);
assert.throws(() => parseProfilePayload({ displayName: 'x'.repeat(41) }), /display name/);

const invoice = parseInvoicePayload({
  invoice: {
    chainId: 5042002,
    contractAddress: ARUSPAY_CONTRACT_ADDRESS,
    merchantAddress: merchant,
    invoiceId,
    amountNative: '1250000000000000000',
    clientName: 'Client Name',
    clientEmail: 'client@example.test',
    description: 'Consulting services',
    expiresAt: '1794275999',
    createTxHash: txHash,
    status: 'paid',
  },
}, subject);
assert.equal(invoice.merchant_privy_user_id, subject, 'The owner is derived from verified token claims, not the request body.');
assert.equal(invoice.merchant_address, merchant);
assert.equal(invoice.invoice_id, invoiceId);
assert.equal(invoice.amount_native, '1250000000000000000');
assert.equal(invoice.client_name, 'Client Name');
assert.equal(invoice.description, 'Consulting services');
assert.equal(invoice.create_tx_hash, txHash);
assert.equal(Object.hasOwn(invoice, 'status'), false, 'No payment status is persisted as invoice metadata.');
assert.equal(Object.hasOwn(invoice, 'paid_at'), false);

assert.throws(() => parseInvoicePayload({ invoice: { ...{
  chainId: 1,
  contractAddress: ARUSPAY_CONTRACT_ADDRESS,
  merchantAddress: merchant,
  invoiceId,
  amountNative: '1',
  createTxHash: txHash,
} } }, subject), /Unsupported chain/);
assert.throws(() => parseInvoicePayload({ invoice: {
  chainId: 5042002,
  contractAddress: merchant,
  merchantAddress: merchant,
  invoiceId,
  amountNative: '1',
  createTxHash: txHash,
} }, subject), /Unsupported invoice contract/);
assert.throws(() => parseInvoicePayload({ invoice: {
  chainId: 5042002,
  contractAddress: ARUSPAY_CONTRACT_ADDRESS,
  merchantAddress: merchant,
  invoiceId,
  amountNative: '0',
  createTxHash: txHash,
} }, subject), /invoice amount/);
assert.throws(() => parseInvoicePayload({ invoice: {
  chainId: 5042002,
  contractAddress: ARUSPAY_CONTRACT_ADDRESS,
  merchantAddress: merchant,
  invoiceId: 'not-a-bytes32',
  amountNative: '1',
  createTxHash: txHash,
} }, subject), /invoice ID/);
assert.throws(() => parseInvoicePayload({ invoice: {
  chainId: 5042002,
  contractAddress: ARUSPAY_CONTRACT_ADDRESS,
  merchantAddress: merchant,
  invoiceId,
  amountNative: '1',
  createTxHash: 'not-a-transaction-hash',
} }, subject), /creation transaction hash/);

const paymentAttempt = parsePaymentAttemptPayload({
  merchantAddress: merchant,
  invoiceId,
  payerAddress: merchant,
  transactionHash: null,
  status: 'paid',
}, subject);
assert.equal(paymentAttempt.payer_privy_user_id, subject);
assert.equal(paymentAttempt.tx_hash, null);
assert.equal(Object.hasOwn(paymentAttempt, 'status'), false, 'A pending-attempt hint cannot write on-chain status.');
assert.deepEqual(parseInvoiceLookup({ merchantAddress: merchant, invoiceId }), {
  merchant_address: merchant,
  invoice_id: invoiceId,
});
assert.equal(parseMerchantAddress({ merchantAddress: merchant }), merchant);
assert.equal(identityTokenHasWallet({
  sub: subject,
  linked_accounts: JSON.stringify([{ type: 'wallet', address: merchant }]),
}, subject, merchant), true);
assert.equal(identityTokenHasWallet({
  sub: 'did:privy:another-user',
  linked_accounts: [{ type: 'wallet', address: merchant }],
}, subject, merchant), false, 'A different Privy identity cannot claim the merchant wallet.');
assert.equal(identityTokenHasWallet({
  sub: subject,
  linked_accounts: [{ type: 'wallet', address: '0x9999999999999999999999999999999999999999' }],
}, subject, merchant), false);
assert.equal(identityTokenHasWallet({ sub: subject, linked_accounts: 'not-json' }, subject, merchant), false);

const edgeFunction = await readFile(new URL('../supabase/functions/aruspay-api/index.ts', import.meta.url), 'utf8');
assert.match(edgeFunction, /jwtVerify\(match\[1\], jwks,\s*\{[\s\S]*issuer: PRIVY_ISSUER,[\s\S]*audience: PRIVY_APP_ID,[\s\S]*algorithms: \["ES256"\]/);
assert.match(edgeFunction, /payload\.sub\.startsWith\("did:privy:"\)/);
assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/);
assert.match(edgeFunction, /payment_attempts/);
assert.match(edgeFunction, /verifyInvoiceWalletIdentity/);
assert.match(edgeFunction, /X-Privy-Identity-Token/);
assert.doesNotMatch(edgeFunction, /\.select\([^)]*status|paid_at|payment_status/i);

const frontend = await readFile(new URL('../src/metadata-api.js', import.meta.url), 'utf8');
assert.doesNotMatch(frontend, /localStorage|sessionStorage/);
assert.match(frontend, /Authorization: `Bearer \$\{accessToken\}`/);
assert.match(frontend, /credentials: 'omit'/);

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.window = {
  arusPayCurrentPrivyUserId: subject,
  arusPayPrivy: {
    getAccessToken: async () => 'privy-test-token',
    getIdentityToken: async () => 'privy-identity-test-token',
  },
};
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), options });
  return new Response(JSON.stringify({ profile: { display_name: 'Cloud User' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const { metadataApi } = await import('../src/metadata-api.js');
const result = await metadataApi.saveProfile('Cloud User');
assert.equal(result.profile.display_name, 'Cloud User');
assert.equal(requests.length, 1);
assert.match(requests[0].url, /xudcqwfyrfsjrjxbcssy\.supabase\.co\/functions\/v1\/aruspay-api$/);
assert.equal(requests[0].options.headers.Authorization, 'Bearer privy-test-token');
assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'save_profile', displayName: 'Cloud User', expectedPrivyUserId: subject });
assert.equal(requests[0].options.credentials, 'omit');
const invoiceMetadata = { merchantAddress: merchant, invoiceId };
await metadataApi.saveInvoice(invoiceMetadata);
assert.equal(requests.length, 2);
assert.equal(requests[1].options.headers['X-Privy-Identity-Token'], 'privy-identity-test-token');
assert.deepEqual(JSON.parse(requests[1].options.body), { action: 'save_invoice', invoice: invoiceMetadata, expectedPrivyUserId: subject });
await metadataApi.listInvoices(merchant);
assert.equal(requests.length, 3);
assert.equal(requests[2].options.headers['X-Privy-Identity-Token'], 'privy-identity-test-token');

globalThis.window = {
  arusPayCurrentPrivyUserId: subject,
  arusPayPrivy: {
    getAccessToken: async () => 'privy-test-token',
    getIdentityToken: async () => null,
  },
};
await assert.rejects(metadataApi.saveInvoice(invoiceMetadata), /identity tokens must be enabled/);
await assert.rejects(metadataApi.listInvoices(merchant), /identity tokens must be enabled/);
assert.equal(requests.length, 3, 'Missing identity proof must stop before the network request.');
globalThis.window = { arusPayCurrentPrivyUserId: subject, arusPayPrivy: { getAccessToken: async () => null } };
await assert.rejects(metadataApi.getProfile(), /Sign in with Privy/);

const sequence = [];
let finishSave;
globalThis.window = { arusPayCurrentPrivyUserId: subject, arusPayPrivy: { getAccessToken: async () => 'access' } };
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  sequence.push(body.action);
  if (body.action === 'save_payment_attempt') await new Promise(resolve => { finishSave = resolve; });
  return new Response('{}', { status: 200 });
};
const saving = metadataApi.savePaymentAttempt(merchant, invoiceId, merchant);
const clearing = metadataApi.clearPaymentAttempt(merchant, invoiceId);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(sequence, ['save_payment_attempt'], 'Delete must wait for the earlier save to finish.');
finishSave();
await Promise.all([saving, clearing]);
assert.deepEqual(sequence, ['save_payment_attempt', 'clear_payment_attempt']);

let finishToken;
globalThis.window.arusPayPrivy.getAccessToken = () => new Promise(resolve => { finishToken = resolve; });
const staleRequest = metadataApi.saveProfile('Previous account');
globalThis.window.arusPayCurrentPrivyUserId = 'did:privy:new-account';
finishToken('access');
await assert.rejects(staleRequest, /account changed/);
assert.equal(sequence.length, 2, 'Account switching during token retrieval must stop before network access.');

globalThis.window = originalWindow;
globalThis.fetch = originalFetch;

console.log('Supabase metadata and Privy-authenticated API regression tests passed.');
