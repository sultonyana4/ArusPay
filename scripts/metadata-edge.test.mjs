import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import * as domain from '../supabase/functions/aruspay-api/domain.js';

const subject = 'did:privy:edge-test';
const merchant = '0x1234567890abcdef1234567890abcdef12345678';
const invoiceId = `0x${'ab'.repeat(32)}`;
const operations = [];
let handler;
function builder(table) {
  const operation = { table, filters: [] };
  operations.push(operation);
  const result = () => ({ data: operation.row || (table === 'profiles' ? null : []), error: null });
  const query = {
    select(columns) { operation.columns = columns; return query; },
    eq(column, value) { operation.filters.push([column, value]); return query; },
    order() { return query; },
    limit() { return query; },
    upsert(row) { operation.row = row; return query; },
    delete() { operation.deleted = true; return query; },
    maybeSingle() { return Promise.resolve(result()); },
    single() { return Promise.resolve(result()); },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return query;
}
const jwtVerify = async (token, _jwks, options) => {
  assert.equal(options.issuer, domain.PRIVY_ISSUER);
  assert.equal(options.audience, domain.PRIVY_APP_ID);
  assert.deepEqual(options.algorithms, ['ES256']);
  if (token === 'access') return { payload: { sub: subject } };
  if (token === 'identity') return { payload: { sub: subject, linked_accounts: JSON.stringify([{ type: 'wallet', address: merchant }]) } };
  if (token === 'wrong-user') return { payload: { sub: 'did:privy:other', linked_accounts: [{ type: 'wallet', address: merchant }] } };
  if (token === 'wrong-wallet') return { payload: { sub: subject, linked_accounts: [] } };
  throw new Error('Invalid token');
};
const source = await readFile(new URL('../supabase/functions/aruspay-api/index.ts', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'index.ts', { format: 'cjs', target: 'es2022' });
const requireMock = (name) => {
  if (name.startsWith('jsr:')) return {};
  if (name.includes('@supabase/supabase-js')) return { createClient: () => ({ from: builder }) };
  if (name.includes('/jose@')) return { createRemoteJWKSet: () => ({}), jwtVerify };
  if (name === './domain.js') return domain;
  throw new Error(`Unexpected dependency: ${name}`);
};
new Function('require', 'Deno', code)(requireMock, {
  env: { get: () => 'server-only-test-value' },
  serve: (callback) => { handler = callback; },
});
assert.equal(typeof handler, 'function');
const invoice = {
  chainId: domain.ARC_CHAIN_ID,
  contractAddress: domain.ARUSPAY_CONTRACT_ADDRESS,
  merchantAddress: merchant,
  invoiceId,
  amountNative: '1000000000000000000',
  createTxHash: `0x${'cd'.repeat(32)}`,
  description: 'Test-only isolated fixture',
  merchant_privy_user_id: 'did:privy:forged',
  status: 'paid',
};
async function request(action, { identity, access = 'access', origin = domain.PRODUCTION_ORIGIN, payload = {} } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  if (access) headers.Authorization = `Bearer ${access}`;
  if (identity) headers['X-Privy-Identity-Token'] = identity;
  const before = operations.length;
  const response = await handler(new Request('https://example.test/aruspay-api', {
    method: 'POST', headers, body: JSON.stringify({ action, expectedPrivyUserId: subject, ...payload }),
  }));
  return { response, operations: operations.slice(before) };
}
for (const identity of [undefined, 'wrong-user', 'wrong-wallet', 'invalid']) {
  for (const action of ['get_invoices', 'save_invoice']) {
    const result = await request(action, { identity, payload: { merchantAddress: merchant, invoice } });
    assert.equal(result.response.status, 403, `${action} must reject missing or mismatched linked-wallet proof`);
    assert.equal(result.operations.length, 0, 'Authorization must run before database access.');
  }
}
const read = await request('get_invoices', { identity: 'identity', payload: { merchantAddress: merchant } });
assert.equal(read.response.status, 200);
assert.deepEqual(read.operations[0].filters, [
  ['merchant_privy_user_id', subject], ['chain_id', domain.ARC_CHAIN_ID],
  ['contract_address', domain.ARUSPAY_CONTRACT_ADDRESS], ['merchant_address', merchant],
]);
const save = await request('save_invoice', { identity: 'identity', payload: { invoice } });
assert.equal(save.response.status, 200);
assert.equal(save.operations[0].row.merchant_privy_user_id, subject);
assert.equal(Object.hasOwn(save.operations[0].row, 'status'), false);
const unauthenticated = await request('get_profile', { access: null });
assert.equal(unauthenticated.response.status, 401);
assert.equal(unauthenticated.operations.length, 0);
const wrongAccount = await request('save_profile', { payload: { displayName: 'Stale account', expectedPrivyUserId: 'did:privy:other' } });
assert.equal(wrongAccount.response.status, 403);
assert.equal(wrongAccount.operations.length, 0);
const preview = await request('get_profile', { origin: 'https://aruspay-preview.vercel.app' });
assert.equal(preview.response.status, 403);
assert.equal(preview.operations.length, 0);
const profile = await request('get_profile');
assert.equal(profile.response.status, 200);
assert.deepEqual(profile.operations[0].filters, [['privy_user_id', subject]]);
console.log('Edge Function route authorization tests passed (mocked JWT/database only; no network or transactions).');
