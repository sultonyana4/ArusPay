const EVM_CHAIN_TYPES = new Set(['ethereum', 'evm']);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const WALLET_TYPE_LABELS = new Map([
  ['privy', 'Privy embedded'],
  ['privy-v2', 'Privy embedded'],
  ['metamask', 'MetaMask'],
  ['coinbase_wallet', 'Coinbase Wallet'],
  ['wallet_connect', 'WalletConnect'],
  ['rainbow', 'Rainbow'],
  ['injected', 'Browser injected'],
]);

const PROVIDER_LOOKUP_STATES = new Set(['not-started', 'pending', 'resolved', 'rejected', 'timeout']);
const SAFE_WALLET_LABELS = new Set([
  'Privy embedded',
  'MetaMask',
  'Coinbase Wallet',
  'WalletConnect',
  'Rainbow',
  'Browser injected',
  'Other EVM wallet',
  'Unknown EVM wallet',
]);
const ARC_TESTNET_CHAIN_ID = '0x4cef52';

export function isEvmConnectedWallet(wallet) {
  const walletType = wallet?.type;
  const chainType = wallet?.chainType;
  return Boolean(
    wallet &&
    typeof wallet.address === 'string' &&
    EVM_ADDRESS.test(wallet.address) &&
    (walletType === 'ethereum' || EVM_CHAIN_TYPES.has(chainType)),
  );
}

function walletTypeLabel(walletClientType) {
  if (typeof walletClientType !== 'string') return 'Unknown EVM wallet';
  return WALLET_TYPE_LABELS.get(walletClientType.toLowerCase()) || 'Other EVM wallet';
}

function safeChainId(chainId) {
  return typeof chainId === 'string' && /^0x[0-9a-f]{1,64}$/i.test(chainId)
    ? chainId.toLowerCase()
    : 'unavailable';
}

export function createSafeWalletDiagnostics({
  sessionReady = false,
  authenticated = false,
  walletsReady = false,
  wallets = [],
  selectedWalletClientType = '',
  providerLookupState = 'not-started',
  chainId = null,
} = {}) {
  const connectedEvmWallets = (Array.isArray(wallets) ? wallets : []).filter(isEvmConnectedWallet);
  const typeCounts = new Map();
  for (const wallet of connectedEvmWallets) {
    const label = walletTypeLabel(wallet.walletClientType);
    typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
  }

  return {
    privySessionReady: Boolean(sessionReady),
    privyAuthenticated: Boolean(authenticated),
    useWalletsReady: Boolean(walletsReady),
    connectedEvmWalletCount: connectedEvmWallets.length,
    connectedEvmWalletTypes: [...typeCounts.entries()].map(([type, count]) => `${type} × ${count}`),
    selectedWalletProviderType: selectedWalletClientType
      ? walletTypeLabel(selectedWalletClientType)
      : 'None',
    getEthereumProvider: PROVIDER_LOOKUP_STATES.has(providerLookupState)
      ? providerLookupState
      : 'not-started',
    ethChainId: safeChainId(chainId),
  };
}

function normalizeWalletDiagnostics(diagnostics) {
  diagnostics = diagnostics || {};
  if (typeof diagnostics?.privySessionReady !== 'boolean'
    || typeof diagnostics?.privyAuthenticated !== 'boolean'
    || typeof diagnostics?.useWalletsReady !== 'boolean') {
    return createSafeWalletDiagnostics(diagnostics);
  }

  const count = Number.isSafeInteger(diagnostics.connectedEvmWalletCount)
    ? Math.max(0, Math.min(diagnostics.connectedEvmWalletCount, 10_000))
    : 0;
  const types = Array.isArray(diagnostics.connectedEvmWalletTypes)
    ? diagnostics.connectedEvmWalletTypes.filter((entry) => {
      if (typeof entry !== 'string') return false;
      const match = entry.match(/^(.+) × (\d{1,5})$/);
      return Boolean(match && SAFE_WALLET_LABELS.has(match[1]));
    }).slice(0, 16)
    : [];
  const selectedType = SAFE_WALLET_LABELS.has(diagnostics.selectedWalletProviderType)
    ? diagnostics.selectedWalletProviderType
    : diagnostics.selectedWalletProviderType === 'None' ? 'None' : 'Other EVM wallet';

  return {
    privySessionReady: diagnostics.privySessionReady,
    privyAuthenticated: diagnostics.privyAuthenticated,
    useWalletsReady: diagnostics.useWalletsReady,
    connectedEvmWalletCount: count,
    connectedEvmWalletTypes: types,
    selectedWalletProviderType: selectedType,
    getEthereumProvider: PROVIDER_LOOKUP_STATES.has(diagnostics.getEthereumProvider)
      ? diagnostics.getEthereumProvider
      : 'not-started',
    ethChainId: safeChainId(diagnostics.ethChainId),
  };
}

export function formatSafeWalletDiagnostics(diagnostics) {
  const safe = normalizeWalletDiagnostics(diagnostics);
  const session = !safe.privySessionReady
    ? 'initializing'
    : safe.privyAuthenticated ? 'ready, authenticated' : 'ready, not authenticated';
  return [
    'Termul wallet diagnostics (read-only)',
    `Privy session: ${session}`,
    `useWallets.ready: ${safe.useWalletsReady ? 'true' : 'false'}`,
    `Connected EVM wallets: ${safe.connectedEvmWalletCount}${safe.connectedEvmWalletTypes.length
      ? ` (${safe.connectedEvmWalletTypes.join(', ')})`
      : ''}`,
    `Selected wallet/provider type: ${safe.selectedWalletProviderType}`,
    `getEthereumProvider: ${safe.getEthereumProvider}`,
    `eth_chainId: ${safe.ethChainId}`,
    'No wallet addresses, account details, email, tokens, keys, codes, signatures, or telemetry are included.',
  ].join('\n');
}

export function walletDiagnosticsNextStep(diagnostics) {
  const safe = normalizeWalletDiagnostics(diagnostics);
  if (!safe.privySessionReady) {
    return 'Keep this page open until the Privy session finishes loading, then copy and send the safe diagnostics below. Do not repeat Retry.';
  }
  if (!safe.privyAuthenticated) {
    return 'Sign in with Privy on this page, then copy and send the safe diagnostics below. No signature or transaction is needed for this check.';
  }
  if (!safe.useWalletsReady) {
    return 'Privy has not finished loading its wallet list. Copy and send the safe diagnostics below; do not repeat Retry.';
  }
  if (safe.connectedEvmWalletCount === 0) {
    return 'Privy currently exposes no connected EVM wallet. Reopen/connect the EVM wallet in Privy, then copy and send the safe diagnostics below.';
  }
  if (safe.ethChainId !== 'unavailable' && safe.ethChainId !== ARC_TESTNET_CHAIN_ID) {
    return 'Switch the selected wallet to Arc Testnet, then copy and send the safe diagnostics below. This read-only check does not test signing.';
  }
  if (safe.getEthereumProvider === 'rejected') {
    return 'Privy rejected the provider lookup. Copy and send the safe diagnostics below; there is no need to repeat Retry.';
  }
  if (safe.getEthereumProvider === 'timeout') {
    return 'The Privy provider lookup timed out. Copy and send the safe diagnostics below; there is no need to repeat Retry.';
  }
  return 'Copy and send the safe diagnostics below so the wallet connection can be investigated. Do not repeat Retry; this read-only check does not test signing.';
}
