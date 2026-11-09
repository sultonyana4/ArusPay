import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://aruspay.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const copied = [];
window.navigator.clipboard = { writeText: async (address) => { copied.push(address); } };
const inlineScripts = [...window.document.querySelectorAll('script:not([src])')]
  .map((script) => script.textContent)
  .filter(Boolean);
for (const script of inlineScripts) window.eval(script);

const exported = [];
let linked = 0;
window.arusPayPrivy = {
  exportWallet: async (address) => { exported.push(address); },
  linkTwitter: () => { linked += 1; },
};
const user = {
  id: 'did:privy:smoke-test',
  linkedAccounts: [
    { type: 'email', address: 'smoke@example.test' },
    { type: 'twitter_oauth', username: 'smokeuser' },
    {
      type: 'wallet',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      walletClientType: 'privy',
      chainType: 'ethereum',
    },
  ],
};
const address = user.linkedAccounts[2].address;
const wallets = [{ address, walletClientType: 'privy', chainType: 'ethereum' }];
window.arusPayAuthenticated(user, wallets);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(window.document.querySelector('#wallet-balance').textContent, '—', 'A wallet balance is not fabricated before a chain read completes.');
assert.match(window.document.querySelector('#wallet-balance-state').textContent, /Connect a Privy wallet/);
window.arusPayApi.replaceInvoices([{
  id: 'unverified', invoiceId: `0x${'1'.repeat(64)}`, name: 'Test invoice', initials: 'TI',
  amount: 99, status: 'paid', createdAt: new Date().toISOString(), onchainVerified: false,
}]);
assert.equal(window.document.querySelector('#received-total').textContent, '0.00', 'An unverified payment is not counted as revenue.');
assert.equal(window.document.querySelector('#paid-count').textContent, '0');
assert.match(window.document.querySelector('#payment-activity-empty').textContent, /No confirmed payment activity/);
window.arusPayApi.replaceInvoices([{
  id: 'verified', invoiceId: `0x${'2'.repeat(64)}`, name: 'On-chain invoice', initials: 'AP',
  amount: 4.25, amountBase: '4250000000000000000', status: 'paid', createdAt: new Date().toISOString(), paymentExplorerUrl: 'https://explorer.testnet.arc.io/tx/0xabc',
  createTxHash: `0x${'3'.repeat(64)}`, onchainVerified: true,
}]);
assert.equal(window.document.querySelector('#received-total').textContent, '4.25', 'Only verified on-chain payments count as received.');
assert.equal(window.document.querySelector('#paid-count').textContent, '1');
window.arusPayApi.clearInvoices();
window.navigate('profile');
assert.equal(window.document.querySelector('#profile-view').classList.contains('hidden'), false);
assert.match(window.document.querySelector('#linked-account-list').textContent, /smoke@example\.test/);
assert.match(window.document.querySelector('#x-link-status').textContent, /@smokeuser/);
assert.match(window.document.querySelector('#wallet-address-list').textContent, new RegExp(address));
assert.match(window.document.querySelector('#export-wallet-actions').textContent, /Export private key/);
window.document.querySelector('[data-copy-wallet]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(copied, [address]);

const name = window.document.querySelector('#display-name-input');
name.value = 'Local Profile';
window.document.querySelector('#display-name-form').dispatchEvent(new window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
assert.equal(window.localStorage.getItem('aruspay:profile-display-name:did:privy:smoke-test'), 'Local Profile');
assert.equal(window.localStorage.length, 1, 'Only the local display name is stored in this test.');
assert.match(window.document.querySelector('#display-name-status').textContent, /not synced to a cloud profile/);
window.document.querySelector('#link-x-button').click();
assert.equal(linked, 0, 'An already-linked X account must not start a new link flow.');

const exportButton = window.document.querySelector('[data-export-wallet]');
exportButton.click();
assert.equal(window.document.querySelector('#key-export-confirm').classList.contains('hidden'), false);
assert.equal(exported.length, 0, 'Export must wait for explicit confirmation.');
window.document.querySelector('#cancel-key-export').click();
assert.equal(exported.length, 0, 'Cancel must not start export.');
exportButton.click();
window.document.querySelector('#confirm-key-export').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(exported, [address]);
assert.match(window.document.querySelector('.modal-warning').textContent, /Anyone with this private key can control your wallet/);

const noXUser = {
  id: 'did:privy:no-x',
  linkedAccounts: [{ type: 'email', address: 'no-x@example.test' }],
};
window.arusPayAuthenticated(noXUser, []);
window.navigate('profile');
assert.notEqual(window.document.querySelector('#display-name-input').value, 'Local Profile', 'Names must be scoped to each Privy user.');
window.document.querySelector('#link-x-button').click();
assert.equal(linked, 1, 'An unlinked X account must call the Privy link method.');
assert.match(window.document.querySelector('#wallet-address-list').textContent, /No Privy embedded EVM wallet found/);
assert.match(window.document.querySelector('#export-wallet-actions').textContent, /No Privy embedded wallet available/);

window.arusPayAuthenticated({ id: 'did:privy:external', linkedAccounts: [] }, [{
  address,
  walletClientType: 'metamask',
  chainType: 'ethereum',
}]);
window.navigate('profile');
assert.equal(window.document.querySelector('[data-export-wallet]'), null, 'External wallets must not expose an embedded-key export action.');
window.arusPayUnauthenticated();
assert.equal(window.document.querySelector('#signin').classList.contains('hidden'), false);

console.log('PASS: profile route, linked identities, copy address, local-only name, user isolation, X-link gating, export confirmation/cancel, and embedded-wallet-only empty states.');
dom.window.close();
