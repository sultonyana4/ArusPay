import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createSafeWalletDiagnostics,
  formatSafeWalletDiagnostics,
  isEvmConnectedWallet,
  walletDiagnosticsNextStep,
} from '../src/privy-diagnostics.js';
import { selectWalletsForOnchainSync, waitForConnectedEthereumProvider } from '../src/privy-wallets.js';

const installedPrivy = JSON.parse(await readFile(new URL('../node_modules/@privy-io/react-auth/package.json', import.meta.url), 'utf8'));
assert.equal(installedPrivy.version, '3.51.3', 'These regression fixtures target the installed Privy React Auth 3.51.3 SDK.');
const diagnosticsSource = await readFile(new URL('../src/privy-diagnostics.js', import.meta.url), 'utf8');
assert.doesNotMatch(diagnosticsSource, /\bfetch\b|sendBeacon|XMLHttpRequest/, 'Runtime diagnostics stay local and send no telemetry.');

// In Privy 3.51.3, ConnectedWallet is an Ethereum wallet with `type: 'ethereum'`,
// `walletClientType`, `address`, and `getEthereumProvider()`; it need not expose `chainType`.
const embeddedAddress = '0x1234567890abcdef1234567890abcdef12345678';
const externalAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const testProvider = { request: async ({ method }) => method === 'eth_chainId' ? '0x4cef52' : null };
const sdkEmbeddedWallet = {
  type: 'ethereum',
  address: embeddedAddress,
  walletClientType: 'privy',
  getEthereumProvider: async () => testProvider,
  meta: { name: 'account owner@example.test', id: 'private-provider-id' },
};
const sdkExternalWallet = {
  type: 'ethereum',
  address: externalAddress,
  walletClientType: 'metamask',
  getEthereumProvider: async () => testProvider,
};
const solanaWallet = {
  type: 'solana',
  address: 'private-solana-address',
  walletClientType: 'privy',
};

assert.equal(isEvmConnectedWallet(sdkEmbeddedWallet), true, 'SDK `type: ethereum` wallets count as connected EVM wallets.');
assert.equal(isEvmConnectedWallet({ ...sdkEmbeddedWallet, type: 'solana' }), false, 'Solana wallets are excluded.');
assert.equal(isEvmConnectedWallet({ ...sdkEmbeddedWallet, address: 'not-an-address' }), false, 'Malformed addresses are not counted.');
assert.equal(isEvmConnectedWallet({ ...sdkEmbeddedWallet, type: undefined, chainType: 'evm' }), true, 'Legacy chainType EVM wallet objects remain supported.');

const selected = selectWalletsForOnchainSync([sdkEmbeddedWallet, solanaWallet], { linkedAccounts: [] });
assert.deepEqual(selected, [sdkEmbeddedWallet, solanaWallet], 'SDK-shape EVM wallets remain available to the on-chain selection flow.');

const providerStates = [];
const resolvedProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [sdkEmbeddedWallet],
  isReady: () => true,
  address: embeddedAddress,
  walletClientType: 'privy',
  onProviderState: (state) => providerStates.push(state),
  timeoutMs: 100,
  retryIntervalMs: 2,
});
assert.equal(resolvedProvider, testProvider, 'The matching SDK wallet provider resolves.');
assert.deepEqual(providerStates, ['pending', 'resolved'], 'Provider diagnostics transition pending → resolved.');

const failedStates = [];
const rejectedProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [{
    ...sdkEmbeddedWallet,
    getEthereumProvider: async () => { throw new Error('private provider exception text'); },
  }],
  isReady: () => true,
  address: embeddedAddress,
  walletClientType: 'privy',
  onProviderState: (state) => failedStates.push(state),
  timeoutMs: 35,
  retryIntervalMs: 2,
});
assert.equal(rejectedProvider, null, 'Rejected SDK provider lookups do not return a provider.');
assert.ok(failedStates.includes('rejected'), 'Provider diagnostics distinguish a rejected lookup.');
assert.equal(failedStates.at(-1), 'rejected', 'The final rejected state is preserved instead of hidden as a generic failure.');

const timedOutStates = [];
const timedOutProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [{ ...sdkEmbeddedWallet, getEthereumProvider: () => new Promise(() => {}) }],
  isReady: () => true,
  address: embeddedAddress,
  walletClientType: 'privy',
  onProviderState: (state) => timedOutStates.push(state),
  timeoutMs: 30,
  retryIntervalMs: 2,
});
assert.equal(timedOutProvider, null, 'A provider getter that never settles is bounded.');
assert.ok(timedOutStates.includes('pending') && timedOutStates.includes('timeout'), 'Provider diagnostics distinguish pending from timeout.');
assert.equal(timedOutStates.at(-1), 'timeout');

const notReadyStates = [];
const notReadyProvider = await waitForConnectedEthereumProvider({
  getWallets: () => [sdkEmbeddedWallet],
  isReady: () => false,
  address: embeddedAddress,
  walletClientType: 'privy',
  onProviderState: (state) => notReadyStates.push(state),
  timeoutMs: 15,
  retryIntervalMs: 2,
});
assert.equal(notReadyProvider, null);
assert.deepEqual(notReadyStates, ['timeout'], 'A wallet list that never becomes ready is reported as a timeout, not as a resolved signer.');

const safe = createSafeWalletDiagnostics({
  sessionReady: true,
  authenticated: true,
  walletsReady: true,
  wallets: [sdkEmbeddedWallet, sdkExternalWallet, solanaWallet],
  selectedWalletClientType: 'privy',
  providerLookupState: 'resolved',
  chainId: '0x4cef52',
});
assert.deepEqual(safe, {
  privySessionReady: true,
  privyAuthenticated: true,
  useWalletsReady: true,
  connectedEvmWalletCount: 2,
  connectedEvmWalletTypes: ['Privy embedded × 1', 'MetaMask × 1'],
  selectedWalletProviderType: 'Privy embedded',
  getEthereumProvider: 'resolved',
  ethChainId: '0x4cef52',
});
const safeText = formatSafeWalletDiagnostics(safe);
for (const secretLike of [embeddedAddress, externalAddress, 'owner@example.test', 'private-provider-id', 'private-solana-address', 'private provider exception text']) {
  assert.equal(safeText.includes(secretLike), false, `Safe diagnostics must not include ${secretLike}.`);
}
assert.match(safeText, /Privy session: ready, authenticated/);
assert.match(safeText, /useWallets\.ready: true/);
assert.match(safeText, /Connected EVM wallets: 2 \(Privy embedded × 1, MetaMask × 1\)/);
assert.match(safeText, /Selected wallet\/provider type: Privy embedded/);
assert.match(safeText, /getEthereumProvider: resolved/);
assert.match(safeText, /eth_chainId: 0x4cef52/);
assert.equal(Object.hasOwn(safe, 'signerReady'), false, 'A readable chain ID is not presented as proof that the signer is ready.');
assert.doesNotMatch(safeText, /signer ready|signing verified/i);

for (const state of ['pending', 'resolved', 'rejected', 'timeout']) {
  const diagnostic = createSafeWalletDiagnostics({ providerLookupState: state });
  assert.equal(diagnostic.getEthereumProvider, state, `Provider state ${state} is preserved.`);
  assert.match(formatSafeWalletDiagnostics(diagnostic), new RegExp(`getEthereumProvider: ${state}`));
}

const malformed = createSafeWalletDiagnostics({
  sessionReady: true,
  authenticated: true,
  walletsReady: true,
  wallets: [{ ...sdkExternalWallet, walletClientType: 'sensitive custom provider label' }],
  selectedWalletClientType: 'sensitive custom provider label',
  providerLookupState: 'secret-state',
  chainId: 'email=owner@example.test',
});
assert.equal(malformed.connectedEvmWalletTypes[0], 'Other EVM wallet × 1');
assert.equal(malformed.selectedWalletProviderType, 'Other EVM wallet');
assert.equal(malformed.getEthereumProvider, 'not-started');
assert.equal(malformed.ethChainId, 'unavailable');
assert.equal(formatSafeWalletDiagnostics(malformed).includes('sensitive custom provider label'), false);
assert.equal(formatSafeWalletDiagnostics(malformed).includes('owner@example.test'), false);

assert.match(walletDiagnosticsNextStep({ sessionReady: false }), /Keep this page open/);
assert.match(walletDiagnosticsNextStep({ sessionReady: true, authenticated: false }), /Sign in with Privy/);
assert.match(walletDiagnosticsNextStep({ sessionReady: true, authenticated: true, walletsReady: false }), /wallet list/);
assert.match(walletDiagnosticsNextStep({ sessionReady: true, authenticated: true, walletsReady: true, wallets: [] }), /no connected EVM wallet/);
assert.match(walletDiagnosticsNextStep({
  sessionReady: true,
  authenticated: true,
  walletsReady: true,
  wallets: [sdkEmbeddedWallet],
  providerLookupState: 'rejected',
}), /rejected the provider lookup/);
assert.match(walletDiagnosticsNextStep({
  sessionReady: true,
  authenticated: true,
  walletsReady: true,
  wallets: [sdkEmbeddedWallet],
  providerLookupState: 'timeout',
}), /timed out/);
assert.match(walletDiagnosticsNextStep({
  sessionReady: true,
  authenticated: true,
  walletsReady: true,
  wallets: [sdkEmbeddedWallet],
  providerLookupState: 'resolved',
  chainId: '0x1',
}), /Switch the selected wallet to Arc Testnet/);

console.log('Privy wallet diagnostics regression tests passed.');
