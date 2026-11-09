import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { selectWalletsForOnchainSync } from '../src/privy-wallets.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const arcSyncSource = await readFile(new URL('../src/arc-invoices.js', import.meta.url), 'utf8');
const privyAuthSource = await readFile(new URL('../src/privy-auth.jsx', import.meta.url), 'utf8');
const sharedInvoiceSource = arcSyncSource.match(/function openSharedInvoice\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(sharedInvoiceSource, 'A direct payment-link hydration function must exist.');
assert.match(sharedInvoiceSource, /window\.arusPayApi\?\.openInvoice/, 'A valid payment link must select the invoice before asynchronous contract reads.');
assert.doesNotMatch(sharedInvoiceSource, /await\s+getOnchainInvoice/, 'Payment-link selection must not wait for the chain before rendering the loading state.');
assert.match(arcSyncSource, /requestId !== paymentRenderRequest/, 'Late RPC results must not overwrite a newer payment view.');
assert.match(arcSyncSource, /Connect wallet to pay/, 'An invoice must show a wallet connection action without hiding its on-chain details.');
assert.match(arcSyncSource, /Privy found your embedded wallet, but its secure signing connection is still loading/, 'A known Privy wallet without a ready provider must not be called disconnected.');
assert.match(privyAuthSource, /walletsRef\.current\.find/, 'Provider lookup must use the latest Privy wallet list.');
assert.match(privyAuthSource, /const deadline = Date\.now\(\) \+ 2000/, 'Provider lookup must briefly wait for Privy wallet restoration.');
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
assert.equal(window.document.querySelector('#received-total').textContent, '—', 'Revenue must not default to zero before invoice sync.');
assert.equal(window.document.querySelector('#outstanding-total').textContent, '—');
assert.equal(window.document.querySelector('#paid-count').textContent, '—');
assert.match(window.document.querySelector('#invoice-empty').textContent, /Connect a Privy wallet/);

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
const walletSyncCalls = [];
window.arusPayWalletChanged = (selectedWallets) => walletSyncCalls.push(selectedWallets);
const embeddedFallback = selectWalletsForOnchainSync([], user);
assert.deepEqual(embeddedFallback.map((wallet) => wallet.address), [address], 'An authenticated embedded wallet must be available for read-only sync even without a connected provider.');
const directWalletFallback = selectWalletsForOnchainSync([], { wallet: { address } });
assert.equal(directWalletFallback[0]?.address, address, 'The authenticated user.wallet.address is a valid fallback.');
assert.equal(directWalletFallback[0]?.walletClientType, 'privy');
assert.deepEqual(selectWalletsForOnchainSync([], { linkedAccounts: [{ address, walletClientType: 'metamask', chainType: 'ethereum' }] }), [], 'An untrusted linked external wallet is not used as an embedded fallback.');
const activeExternalWallet = { address, walletClientType: 'metamask', chainType: 'ethereum' };
assert.deepEqual(selectWalletsForOnchainSync([activeExternalWallet], user), [activeExternalWallet], 'An actively connected EVM wallet remains preferred for invoice sync.');
window.arusPayAuthenticated(user, embeddedFallback);
assert.equal(walletSyncCalls.at(-1)?.[0]?.address, address, 'The embedded fallback is passed to the Arc sync hook.');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(window.document.querySelector('#wallet-balance').textContent, '—', 'A wallet balance is not fabricated before a chain read completes.');
window.arusPayApi.setInvoiceSyncState('loading');
assert.equal(window.document.querySelector('#received-total').textContent, '—', 'A pending RPC read must not show zero revenue.');
window.arusPayApi.setInvoiceSyncState('error');
assert.equal(window.document.querySelector('#received-total').textContent, '—', 'An RPC error must not be masked by zero revenue.');
assert.match(window.document.querySelector('#received-foot').textContent, /Unavailable/);
window.arusPayApi.setInvoiceSyncState('success');
assert.equal(window.document.querySelector('#received-total').textContent, '0.00', 'A zero is valid only after a successful empty on-chain read.');
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
assert.equal(window.document.querySelector('#profile-wallet-balance').textContent, '—', 'Profile balance must stay empty until the chain read returns.');
const balanceSetter = arcSyncSource.match(/function setWalletBalance\([\s\S]*?\n\}/)?.[0] || '';
assert.match(balanceSetter, /#wallet-balance/);
assert.match(balanceSetter, /#profile-wallet-balance/);
assert.match(balanceSetter, /#profile-wallet-address/);
assert.match(arcSyncSource, /publicClient\.getBalance\(\{\s*address:\s*safeAddress\s*\}\)/);
assert.match(arcSyncSource, /setInvoiceSyncState\('loading'\)/);
assert.match(arcSyncSource, /setInvoiceSyncState\('error'\)/);
assert.match(arcSyncSource, /const ARC_TESTNET_ID = 5042002/);
assert.match(arcSyncSource, /const CONTRACT_ADDRESS = getAddress\('0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926'\)/);
assert.match(arcSyncSource, /functionName: 'createInvoice'/);
assert.match(arcSyncSource, /functionName: 'payInvoice'/);
assert.match(arcSyncSource, /if \(receipt\.status !== 'success'\)/);
assert.match(arcSyncSource, /window\.arusPayApi\?\.addInvoice\(record\)/);
assert.match(arcSyncSource, /const link = makeInvoiceLink\(invoice\.merchant, selected\.invoiceId\)/);
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

const invoiceId = `0x${'cf1f8e1b52d52d06e7c7eaa3383e5164c73b3a5bf1f9fd82b5e92261a4fca598'}`;
const merchant = '0x4D3e3dc6D280cDd8Ba520F8E4B9AC3BF762BBDFe';
const linkDom = new JSDOM(html, {
  url: `https://aruspay-pi.vercel.app/?merchant=${merchant}&invoiceId=${invoiceId}`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
for (const script of linkDom.window.document.querySelectorAll('script:not([src])')) {
  if (script.textContent) linkDom.window.eval(script.textContent);
}
const linkedInvoice = { id: 'INV-CF1F8E1B', invoiceId, merchant, amount: 0.1, amountBase: '100000000000000000', status: 'open' };
linkDom.window.arusPayApi.openInvoice(linkedInvoice);
linkDom.window.arusPayAuthenticated({ id: 'did:privy:existing-session', linkedAccounts: [] }, []);
assert.equal(linkDom.window.document.querySelector('#payment').classList.contains('hidden'), false, 'An existing Privy session must not redirect a payment link to the dashboard.');
assert.equal(linkDom.window.document.querySelector('#workspace').classList.contains('hidden'), true, 'The merchant dashboard must stay hidden for a payer link.');
assert.equal(linkDom.window.arusPayApi.getSelectedInvoice().invoiceId, invoiceId, 'The linked invoice selection must survive session restoration.');
linkDom.window.arusPayUnauthenticated();
assert.equal(linkDom.window.document.querySelector('#payment').classList.contains('hidden'), false, 'Signing out must not hide a public invoice payment page.');
assert.equal(linkDom.window.arusPayApi.getSelectedInvoice().invoiceId, invoiceId, 'The linked invoice selection must survive sign-out.');
linkDom.window.close();

console.log('PASS: profile route, linked identities, copy address, local-only name, user isolation, X-link gating, export confirmation/cancel, embedded-wallet-only empty states, and payment-link routing across Privy session callbacks.');
dom.window.close();
