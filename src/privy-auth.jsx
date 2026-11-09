import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, useExportWallet, useLinkAccount, useLogin, usePrivy, useWallets } from '@privy-io/react-auth';
import { defineChain } from 'viem';
import { selectWalletsForOnchainSync, waitForConnectedEthereumProvider } from './privy-wallets.js';

const ARC_RPC = import.meta.env.VITE_ARUSPAY_BROWSER_RPC_URL || 'https://rpc.blockdaemon.testnet.arc.io';
const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } },
  testnet: true,
});

const appId = import.meta.env.VITE_PRIVY_APP_ID || 'cmw96cg3m00c30hl5gg2jvnxa';

function PrivyBridge() {
  const { login } = useLogin();
  const { authenticated, ready, user, logout } = usePrivy();
  const { wallets, ready: walletsAreReady } = useWallets();
  const walletsRef = useRef(wallets || []);
  walletsRef.current = wallets || [];
  const walletsReadyRef = useRef(Boolean(walletsAreReady));
  walletsReadyRef.current = Boolean(walletsAreReady);
  const { exportWallet } = useExportWallet();
  const { linkTwitter } = useLinkAccount({
    onSuccess: ({ user: linkedUser }) => {
      window.arusPayUserUpdated?.(linkedUser);
      window.arusPayAuthError?.('X account linked to your Privy profile.');
    },
    onError: () => {
      window.arusPayAuthError?.('X account could not be linked. Check your Privy Twitter OAuth settings and try again.');
    },
  });

  useEffect(() => {
    let cancelled = false;
    const loadLoginOptions = async () => {
      const loading = document.getElementById('auth-methods-loading');
      const error = document.getElementById('auth-methods-error');
      try {
        const response = await fetch(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}`, {
          headers: { 'privy-app-id': appId, Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Privy app settings are unavailable.');
        const app = await response.json();
        if (cancelled) return;
        const methods = [
          ['email', app.email_auth],
          ['google', app.google_oauth],
          ['x', app.twitter_oauth],
          ['wallet', app.wallet_auth],
        ];
        for (const [method, enabled] of methods) {
          const button = document.querySelector(`[data-auth="${method}"]`);
          button?.classList.toggle('hidden', enabled !== true);
        }
        loading?.classList.add('hidden');
        if (!methods.some(([, enabled]) => enabled === true) && error) {
          error.textContent = 'No sign-in methods are enabled in Privy yet.';
          error.classList.remove('hidden');
        }
        const walletCopy = document.getElementById('embedded-wallet-copy');
        const createOnLogin = app.embedded_wallet_config?.ethereum?.create_on_login;
        if (walletCopy && ['users-without-wallets', 'all-users'].includes(createOnLogin)) {
          walletCopy.textContent = 'New users without wallets receive a Privy embedded wallet.';
          walletCopy.classList.remove('hidden');
        }
      } catch {
        if (cancelled) return;
        loading?.classList.add('hidden');
        if (error) {
          error.textContent = 'Sign-in options could not be loaded. Refresh to try again.';
          error.classList.remove('hidden');
        }
      }
    };
    loadLoginOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.arusPayPrivy = {
      login: async (method) => {
        const loginMethod = method === 'x' ? 'twitter' : method;
        try {
          await login({
            loginMethods: [loginMethod],
            ...(loginMethod === 'wallet' ? { walletChainType: 'ethereum-only' } : {}),
          });
        } catch {
          window.arusPayAuthError?.('Sign-in could not be completed. Check your Privy login settings and try again.');
        }
      },
      linkTwitter: () => {
        if (!authenticated) {
          window.arusPayAuthError?.('Sign in with Privy before linking an X account.');
          return;
        }
        try {
          linkTwitter();
        } catch {
          window.arusPayAuthError?.('X account linking could not be started. Please try again.');
        }
      },
      exportWallet: async (address) => {
        await exportWallet({ address });
      },
      logout: async () => {
        try {
          await logout();
        } catch {
          window.arusPayAuthError?.('Sign-out could not be completed. Please try again.');
        }
      },
      getEthereumProvider: async ({ address, walletClientType } = {}) => waitForConnectedEthereumProvider({
        getWallets: () => walletsRef.current,
        isReady: () => walletsReadyRef.current,
        address,
        walletClientType,
        fallbackProvider: window.ethereum,
      }),
    };

    return () => {
      delete window.arusPayPrivy;
    };
  }, [authenticated, exportWallet, linkTwitter, login, logout, wallets, walletsAreReady]);

  useEffect(() => {
    if (!ready) return;
    if (authenticated && user) {
      const onchainWallets = selectWalletsForOnchainSync(wallets || [], user);
      window.arusPayAuthenticated?.(user, onchainWallets);
    } else {
      window.arusPayUnauthenticated?.();
    }
  }, [authenticated, ready, user, wallets]);

  return null;
}

function PrivyRoot() {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'google', 'twitter', 'wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#65e4d0',
        },
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}

createRoot(document.getElementById('privy-root')).render(<PrivyRoot />);
