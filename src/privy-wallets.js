const EVM_CHAIN_TYPES = new Set(['ethereum', 'evm']);
const PRIVY_WALLET_CLIENT_TYPES = new Set(['privy', 'privy-v2']);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isPrivyWalletClientType(walletClientType) {
  return PRIVY_WALLET_CLIENT_TYPES.has(walletClientType);
}

export function isExpectedHexChainId(chainId, expectedChainId) {
  return typeof chainId === 'string'
    && /^0x[0-9a-f]+$/i.test(chainId)
    && Number.parseInt(chainId, 16) === expectedChainId;
}

export function withTimeout(operation, timeoutMs, message = 'The operation timed out.') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, timeoutMs));
  });
  return Promise.race([
    Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function isEvmWallet(wallet) {
  return Boolean(
    wallet &&
    typeof wallet.address === 'string' &&
    EVM_ADDRESS.test(wallet.address) &&
    EVM_CHAIN_TYPES.has(wallet.chainType),
  );
}

export function selectWalletsForOnchainSync(activeWallets, user) {
  const connected = Array.isArray(activeWallets) ? activeWallets : [];
  if (connected.some(isEvmWallet)) return connected;

  const linkedAccounts = Array.isArray(user?.linkedAccounts) ? user.linkedAccounts : [];
  const directWallet = user?.wallet && typeof user.wallet === 'object' && user.wallet.address
    ? [{
        ...user.wallet,
        walletClientType: user.wallet.walletClientType || 'privy',
        chainType: user.wallet.chainType || 'ethereum',
      }]
    : [];
  const seenAddresses = new Set();

  return [...linkedAccounts, ...directWallet].filter((wallet) => {
    if (!isEvmWallet(wallet) || !PRIVY_WALLET_CLIENT_TYPES.has(wallet.walletClientType)) return false;
    const address = wallet.address.toLowerCase();
    if (seenAddresses.has(address)) return false;
    seenAddresses.add(address);
    return true;
  });
}

export async function waitForConnectedEthereumProvider({
  getWallets,
  isReady,
  address,
  walletClientType,
  fallbackProvider,
  timeoutMs = 12_000,
  retryIntervalMs = 200,
}) {
  const expectedAddress = typeof address === 'string' ? address.toLowerCase() : '';
  const embeddedWallet = isPrivyWalletClientType(walletClientType);
  const deadline = Date.now() + timeoutMs;

  if (!embeddedWallet && !expectedAddress && fallbackProvider && typeof fallbackProvider.request === 'function') {
    return fallbackProvider;
  }

  while (Date.now() < deadline) {
    if (isReady()) {
      const currentWallets = getWallets();
      const wallets = Array.isArray(currentWallets) ? currentWallets : [];
      const wallet = wallets.find((item) => (
        isEvmWallet(item) &&
        (!expectedAddress || item.address.toLowerCase() === expectedAddress) &&
        (!walletClientType || item.walletClientType === walletClientType) &&
        typeof item.getEthereumProvider === 'function'
      ));

      if (wallet) {
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          const provider = await withTimeout(
            () => wallet.getEthereumProvider(),
            remainingMs,
            'Privy provider lookup timed out.',
          );
          if (provider && typeof provider.request === 'function') return provider;
        } catch {
          // Privy's secure wallet connection can still be initializing; retry until the deadline.
        }
      }

      if (!embeddedWallet && fallbackProvider && typeof fallbackProvider.request === 'function') {
        return fallbackProvider;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, Math.max(0, deadline - Date.now()))));
  }

  if (!embeddedWallet && fallbackProvider && typeof fallbackProvider.request === 'function') {
    return fallbackProvider;
  }
  return null;
}
