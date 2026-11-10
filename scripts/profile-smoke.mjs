import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isExpectedHexChainId, selectWalletsForOnchainSync, waitForConnectedEthereumProvider, withTimeout } from '../src/privy-wallets.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const arcSyncSource = await readFile(new URL('../src/arc-invoices.js', import.meta.url), 'utf8');
const privyAuthSource = await readFile(new URL('../src/privy-auth.jsx', import.meta.url), 'utf8');
const sharedInvoiceSource = arcSyncSource.match(/function openSharedInvoice\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(sharedInvoiceSource, 'A direct payment-link hydration function must exist.');
assert.match(sharedInvoiceSource, /window\.arusPayApi\?\.openInvoice/, 'A valid payment link must select the invoice before asynchronous contract reads.');
assert.doesNotMatch(sharedInvoiceSource, /await\s+getOnchainInvoice/, 'Payment-link selection must not wait for the chain before rendering the loading state.');
assert.match(arcSyncSource, /requestId !== paymentRenderRequest/, 'Late RPC results must not overwrite a newer payment view.');
assert.match(arcSyncSource, /Connect wallet to pay/, 'An invoice must show a wallet connection action without hiding its on-chain details.');
assert.match(arcSyncSource, /The read-only wallet provider check did not pass/, 'A linked wallet without a verified provider must not be treated as ready.');
assert.match(arcSyncSource, /getRuntimeDiagnostics/, 'A failed wallet check must expose a safe runtime snapshot.');
assert.match(arcSyncSource, /Signing has not been tested here/, 'A read-only provider probe must not claim that signing was tested.');
assert.match(privyAuthSource, /ready: walletsAreReady/, 'Provider lookup must wait for Privy useWallets readiness.');
assert.match(privyAuthSource, /waitForConnectedEthereumProvider/, 'Provider lookup must use the readiness-aware wallet helper.');
assert.match(arcSyncSource, /withTimeout\([\s\S]*?method: 'eth_chainId'/, 'The actual read-only chain probe must have a deadline.');
assert.match(arcSyncSource, /within 12 seconds[\s\S]*No signature or transaction was requested/, 'Timeouts must explain the read-only failure without implying a transaction.');
assert.match(arcSyncSource, /isExpectedHexChainId\(chainId, ARC_TESTNET_ID\)/, 'A provider is not ready unless it proves the Arc Testnet chain ID.');
assert.match(arcSyncSource, /if \(activeWalletAddress && !providerVerified\) \{\s*paymentButton\.disabled = true;/, 'Pay remains disabled until the wallet network check succeeds.');
assert.match(arcSyncSource, /if \(activeWalletAddress && \(activeWalletProviderState !== 'connected' \|\| !activeWalletProviderReady\)\) return;/, 'The click handler independently blocks payment without a verified provider.');
assert.match(arcSyncSource, /Copy safe diagnostics/, 'A failed check must offer one practical way to share only safe runtime state.');
assert.doesNotMatch(arcSyncSource, /Retry Privy connection|Retry wallet connection/, 'The payment page must not encourage repeated blind retries.');
assert.match(arcSyncSource, /wallets\.find\(isEvmConnectedWallet\)/, 'Wallet selection must accept the SDK 3.51.3 `type: ethereum` shape.');
assert.doesNotMatch(privyAuthSource, /Date\.now\(\) \+ 2000/, 'A fixed two-second wallet restoration window must not return early.');
assert.ok(arcSyncSource.includes('paymentButton.disabled = true;'), 'Payment stays disabled until the Privy provider passes a read-only check.');
assert.ok(arcSyncSource.includes("method: 'eth_chainId'"), 'The connection probe must be read-only.');
const dom = new JSDOM(html, {
  url: 'https://aruspay.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const copied = [];
window.navigator.clipboard = { writeText: async (address) => { copied.push(address); } };
const profileSaves = [];
window.arusPayMetadata = {
  getProfile: async () => ({ profile: null }),
  saveProfile: async (displayName) => {
    profileSaves.push(displayName);
    return { profile: { display_name: displayName } };
  },
};
const inlineScripts = [...window.document.querySelectorAll('script:not([src])')]
  .map((script) => script.textContent)
  .filter(Boolean);
for (const script of inlineScripts) window.eval(script);
assert.equal(window.document.querySelector('#received-total').textContent, '—', 'Revenue must not default to zero before invoice sync.');
assert.equal(window.document.querySelector('#outstanding-total').textContent, '—');
assert.equal(window.document.querySelector('#paid-count').textContent, '—');
assert.match(window.document.querySelector('#invoice-empty').textContent, /Connect a Privy wallet/);
assert.doesNotMatch(html, /localStorage|sessionStorage/, 'The application must not persist profile or invoice metadata in browser storage.');

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

const provider = { request: async ({ method }) => method === 'eth_chainId' ? '0x4cef52' : null };
assert.equal(isExpectedHexChainId('0x4cef52', 5042002), true, 'Arc Testnet chain ID is accepted.');
assert.equal(isExpectedHexChainId('0x1', 5042002), false, 'A valid but different chain ID is rejected.');
assert.equal(isExpectedHexChainId('not-a-chain', 5042002), false, 'Malformed chain IDs are rejected.');
let providerWallets = [];
let walletsAreReady = false;
const providerWait = waitForConnectedEthereumProvider({
  getWallets: () => providerWallets,
  isReady: () => walletsAreReady,
  address,
  walletClientType: 'privy',
  fallbackProvider: provider,
  timeoutMs: 100,
  retryIntervalMs: 2,
});
setTimeout(() => {
  providerWallets = [{
    ...wallets[0],
    getEthereumProvider: async () => provider,
  }];
  walletsAreReady = true;
}, 10);
assert.equal(await providerWait, provider, 'A matching Privy provider is returned only after useWallets is ready.');

const otherAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const otherWalletProvider = { request: async () => '0x1' };
const selectedWalletProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [
    { ...wallets[0], address: otherAddress, getEthereumProvider: async () => otherWalletProvider },
    { ...wallets[0], getEthereumProvider: async () => provider },
  ],
  isReady: () => true,
  address,
  walletClientType: 'privy',
  timeoutMs: 10,
  retryIntervalMs: 2,
});
assert.equal(selectedWalletProvider, provider, 'The provider must match the selected embedded-wallet address, not just the first EVM wallet.');

const unrelatedProvider = { request: async () => '0x1' };
const noEmbeddedProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [],
  isReady: () => true,
  address,
  walletClientType: 'privy',
  fallbackProvider: unrelatedProvider,
  timeoutMs: 10,
  retryIntervalMs: 2,
});
assert.equal(noEmbeddedProvider, null, 'An embedded wallet must not silently fall back to an unrelated window.ethereum provider.');

const externalProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [],
  isReady: () => true,
  address,
  walletClientType: 'metamask',
  fallbackProvider: unrelatedProvider,
  timeoutMs: 10,
  retryIntervalMs: 2,
});
assert.equal(externalProvider, unrelatedProvider, 'A non-embedded connected wallet can use the injected provider fallback.');

const startedAt = Date.now();
const neverSettlingProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [{
    ...wallets[0],
    getEthereumProvider: () => new Promise(() => {}),
  }],
  isReady: () => true,
  address,
  walletClientType: 'privy',
  timeoutMs: 30,
  retryIntervalMs: 2,
});
assert.equal(neverSettlingProvider, null, 'A Privy provider getter that never settles must end the readiness check.');
assert.ok(Date.now() - startedAt < 500, 'The provider getter timeout must be bounded.');
await assert.rejects(
  withTimeout(() => new Promise(() => {}), 30, 'read-only probe timed out'),
  /read-only probe timed out/,
  'A hung eth_chainId request must time out instead of leaving the UI in checking state.',
);

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
assert.match(arcSyncSource, /submitInvoiceCreationOnce\(/);
assert.match(arcSyncSource, /broadcastSignedTransactionOnce\(/);
assert.match(arcSyncSource, /pollInvoiceCreationReconciliation\(/);
assert.match(arcSyncSource, /reconcileInvoiceCreationAttempt\(/);
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
name.value = 'Cloud Profile';
window.document.querySelector('#display-name-form').dispatchEvent(new window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(profileSaves, ['Cloud Profile'], 'Display names are saved through the authenticated Supabase API.');
assert.equal(window.localStorage.length, 0, 'The app must not save profile data in browser storage.');
assert.match(window.document.querySelector('#display-name-status').textContent, /Supabase and synced across devices/);
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
let finishOldProfileSave;
window.arusPayMetadata.saveProfile = () => new Promise(resolve => { finishOldProfileSave = resolve; });
name.value = 'Old account delayed name';
window.document.querySelector('#display-name-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
window.arusPayAuthenticated(noXUser, []);
window.navigate('profile');
finishOldProfileSave({ profile: { display_name: 'Old account delayed name' } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.notEqual(window.document.querySelector('#display-name-input').value, 'Old account delayed name', 'A late save response must not contaminate a different account.');
assert.equal(window.document.querySelector('#display-name-form [type=submit]').disabled, false, 'Switching accounts must release the previous account save button.');
assert.notEqual(window.document.querySelector('#display-name-input').value, 'Cloud Profile', 'Names must be scoped to each Privy user.');
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
Object.defineProperty(linkDom.window, 'innerWidth', { value: 390, configurable: true });
for (const script of linkDom.window.document.querySelectorAll('script:not([src])')) {
  if (script.textContent) linkDom.window.eval(script.textContent);
}
const linkedInvoice = { id: 'INV-CF1F8E1B', invoiceId, merchant, amount: 0.1, amountBase: '100000000000000000', status: 'open' };
linkDom.window.arusPayApi.openInvoice(linkedInvoice);
linkDom.window.arusPayAuthenticated({ id: 'did:privy:existing-session', linkedAccounts: [] }, []);
await new Promise((resolve) => setTimeout(resolve, 25)); // Simulate a slow Privy/RPC callback after route hydration.
linkDom.window.arusPayApi.replaceInvoices([]); // Delayed wallet sync may return no merchant invoices.
assert.equal(linkDom.window.document.querySelector('#payment').classList.contains('hidden'), false, 'An existing Privy session must not redirect a payment link to the dashboard.');
assert.equal(linkDom.window.document.querySelector('#workspace').classList.contains('hidden'), true, 'The merchant dashboard must stay hidden for a payer link.');
assert.equal(linkDom.window.arusPayApi.getSelectedInvoice()?.invoiceId, invoiceId, 'A delayed empty wallet sync must not clear the linked invoice selection.');
linkDom.window.arusPayUnauthenticated();
assert.equal(linkDom.window.document.querySelector('#payment').classList.contains('hidden'), false, 'Signing out must not hide a public invoice payment page.');
assert.equal(linkDom.window.arusPayApi.getSelectedInvoice().invoiceId, invoiceId, 'The linked invoice selection must survive sign-out.');
linkDom.window.close();

console.log('PASS: profile route, Supabase-backed display names, no app localStorage persistence, user isolation, linked identities, copy actions, X-link gating, export confirmation/cancel, wallet provider readiness and fallback safety, embedded-wallet-only states, and payment-link routing.');
dom.window.close();
