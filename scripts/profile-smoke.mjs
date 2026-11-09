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
let activeTestUserId = '';
let failProfileSave = false;
const serverProfiles = new Map();
const savedProfiles = [];
window.arusPayPrivy = {
  getProfile: async () => serverProfiles.get(activeTestUserId) ?? null,
  saveProfile: async (displayName) => {
    if (failProfileSave) throw new Error('Simulated API failure.');
    const profile = { display_name: displayName };
    savedProfiles.push({ userId: activeTestUserId, profile });
    serverProfiles.set(activeTestUserId, profile);
    return profile;
  },
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
activeTestUserId = user.id;
window.arusPayAuthenticated(user, wallets);
await new Promise((resolve) => setTimeout(resolve, 0));
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
name.value = 'Cloud Profile';
window.document.querySelector('#display-name-form').dispatchEvent(new window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(serverProfiles.get(user.id)?.display_name, 'Cloud Profile');
assert.deepEqual(savedProfiles.at(-1), { userId: user.id, profile: { display_name: 'Cloud Profile' } });
assert.equal(window.localStorage.length, 0, 'A synced profile name is not stored in localStorage.');
assert.match(window.document.querySelector('#display-name-status').textContent, /synced to your Privy profile/);
failProfileSave = true;
name.value = 'Unsaved Profile';
window.document.querySelector('#display-name-form').dispatchEvent(new window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(serverProfiles.get(user.id)?.display_name, 'Cloud Profile', 'A failed request must not update the saved profile.');
assert.match(window.document.querySelector('#display-name-status').textContent, /No change was saved/);
assert.equal(window.localStorage.length, 0, 'A failed cloud save must not fall back to local-only storage.');
failProfileSave = false;
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
activeTestUserId = noXUser.id;
serverProfiles.set(noXUser.id, { display_name: 'No X Cloud Name' });
window.arusPayAuthenticated(noXUser, []);
await new Promise((resolve) => setTimeout(resolve, 0));
window.navigate('profile');
assert.equal(window.document.querySelector('#display-name-input').value, 'No X Cloud Name', 'The current Privy account loads only its own server profile.');
window.document.querySelector('#link-x-button').click();
assert.equal(linked, 1, 'An unlinked X account must call the Privy link method.');
assert.match(window.document.querySelector('#wallet-address-list').textContent, /No Privy embedded EVM wallet found/);
assert.match(window.document.querySelector('#export-wallet-actions').textContent, /No Privy embedded wallet available/);

const legacyUser = { id: 'did:privy:legacy', linkedAccounts: [] };
activeTestUserId = legacyUser.id;
window.localStorage.setItem(`aruspay:profile-display-name:${legacyUser.id}`, 'Legacy Name');
window.arusPayAuthenticated(legacyUser, []);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(serverProfiles.get(legacyUser.id)?.display_name, 'Legacy Name', 'An existing browser-only name should migrate to the verified profile API.');
assert.equal(window.localStorage.getItem(`aruspay:profile-display-name:${legacyUser.id}`), null, 'Remove the legacy value only after the server confirms the migration.');

activeTestUserId = 'did:privy:external';
window.arusPayAuthenticated({ id: 'did:privy:external', linkedAccounts: [] }, [{
  address,
  walletClientType: 'metamask',
  chainType: 'ethereum',
}]);
window.navigate('profile');
assert.equal(window.document.querySelector('[data-export-wallet]'), null, 'External wallets must not expose an embedded-key export action.');
window.arusPayUnauthenticated();
assert.equal(window.document.querySelector('#signin').classList.contains('hidden'), false);

console.log('PASS: profile route, linked identities, copy address, cloud profile read/write and isolation, safe legacy migration, failed-save handling, X-link gating, export confirmation/cancel, and embedded-wallet-only empty states.');
dom.window.close();
