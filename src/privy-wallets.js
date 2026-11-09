const EVM_CHAIN_TYPES = new Set(['ethereum', 'evm']);
const PRIVY_WALLET_CLIENT_TYPES = new Set(['privy', 'privy-v2']);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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
