import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseUnits,
} from 'viem';
import { isExpectedHexChainId, withTimeout } from './privy-wallets.js';

const ARC_TESTNET_ID = 5042002;
const ARC_ENV = import.meta.env || {};
const ARC_RPC = ARC_ENV.VITE_ARUSPAY_BROWSER_RPC_URL || 'https://rpc.blockdaemon.testnet.arc.io';
const CONTRACT_ADDRESS = getAddress('0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926');
// The contract was deployed at block 71546111; Arc limits eth_getLogs ranges to 10,000 blocks.
const CONTRACT_START_BLOCK = BigInt(ARC_ENV.VITE_ARUSPAY_DEPLOYMENT_BLOCK || '71546111');
const LOG_BLOCK_RANGE = 9999n;
const EXPLORER = 'https://explorer.testnet.arc.io';
const STATUS = { none: 0, open: 1, paid: 2, cancelled: 3 };

const arcTestnet = defineChain({
  id: ARC_TESTNET_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: EXPLORER } },
  testnet: true,
});

const invoiceAbi = [
  {
    type: 'function',
    name: 'createInvoice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'invoiceId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payInvoice',
    stateMutability: 'payable',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'invoiceId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getInvoice',
    stateMutability: 'view',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'invoiceId', type: 'bytes32' },
    ],
    outputs: [
      {
        name: 'invoice',
        type: 'tuple',
        components: [
          { name: 'merchant', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'status', type: 'uint8' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'InvoiceCreated',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'bytes32' },
      { indexed: true, name: 'merchant', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'expiresAt', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'InvoicePaid',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'invoiceId', type: 'bytes32' },
      { indexed: true, name: 'merchant', type: 'address' },
      { indexed: true, name: 'payer', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
];

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const shortId = (id) => `${id.slice(0, 10)}…${id.slice(-8)}`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function formatUsdc(baseUnits) {
  const raw = formatUnits(BigInt(baseUnits), 18);
  const [whole = '0', fraction = ''] = raw.split('.');
  const groupedWhole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(BigInt(whole));
  const significantFraction = fraction.replace(/0+$/, '');
  const shownFraction = significantFraction.padEnd(2, '0');
  return `${groupedWhole}.${shownFraction}`;
}

function parseUsdc(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error('Enter a positive USDC amount with no more than six decimal places.');
  }
  const amount = parseUnits(normalized, 18);
  if (amount <= 0n) throw new Error('Invoice amount must be greater than zero.');
  return amount;
}

function randomInvoiceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function makeInvoiceLink(merchant, invoiceId) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('merchant', merchant);
  url.searchParams.set('invoiceId', invoiceId);
  return url.toString();
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  $('#toast-text').textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3600);
}

function showWalletStatus(address, message = '') {
  const badge = $('#wallet-status');
  if (!badge) return;
  if (address) {
    badge.textContent = `Wallet ${shortAddress(address)}`;
    badge.title = address;
    badge.classList.remove('hidden');
  } else {
    badge.textContent = message || 'Wallet not connected';
    badge.removeAttribute('title');
    badge.classList.remove('hidden');
  }
}

async function getProvider() {
  const isEmbeddedWallet = ['privy', 'privy-v2'].includes(activeWalletType);
  const fromPrivy = await window.arusPayPrivy?.getEthereumProvider?.({
    address: activeWalletAddress,
    walletClientType: activeWalletType,
  });
  const provider = fromPrivy || (isEmbeddedWallet ? null : window.ethereum);
  if (!provider?.request) {
    if (isEmbeddedWallet) {
      throw new Error('Privy recognizes this embedded wallet, but its connected provider is not available in this browser. Retry the read-only connection check; no signature or transaction was requested.');
    }
    if (activeWalletAddress) {
      throw new Error('The connected wallet provider is not available. No signature or transaction was requested.');
    }
    throw new Error('Connect an Ethereum wallet through Privy to continue.');
  }
  return provider;
}

async function ensureTestnet(provider) {
  const chainIdHex = `0x${ARC_TESTNET_ID.toString(16)}`;
  const current = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16);
  if (current !== ARC_TESTNET_ID) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
    } catch (error) {
      if (error?.code !== 4902) throw error;
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: chainIdHex,
          chainName: 'Arc Testnet',
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          rpcUrls: [ARC_RPC],
          blockExplorerUrls: [EXPLORER],
        }],
      });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
    }
  }
  const verified = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16);
  if (verified !== ARC_TESTNET_ID) throw new Error('Switch to Arc Testnet before signing this transaction.');
}

async function getWallet() {
  const provider = await getProvider();
  await ensureTestnet(provider);
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error('No connected wallet was returned.');
  const account = getAddress(accounts[0]);
  if (activeWalletAddress && account.toLowerCase() !== activeWalletAddress.toLowerCase()) {
    throw new Error('The connected provider returned a different wallet than the one selected in Privy. No transaction was sent.');
  }
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: custom(provider) });
  showWalletStatus(account);
  return { provider, account, walletClient };
}

function readInvoiceResult(result) {
  const fields = Array.isArray(result)
    ? { merchant: result[0], amount: result[1], expiresAt: result[2], status: result[3] }
    : result;
  return {
    merchant: getAddress(fields.merchant),
    amount: BigInt(fields.amount),
    expiresAt: BigInt(fields.expiresAt),
    status: Number(fields.status),
  };
}

async function getOnchainInvoice(merchant, invoiceId) {
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: invoiceAbi,
    functionName: 'getInvoice',
    args: [getAddress(merchant), invoiceId],
  });
  return readInvoiceResult(result);
}

async function getMerchantEventLogs(eventName, merchant, latestBlock) {
  const event = invoiceAbi.find((item) => item.type === 'event' && item.name === eventName);
  if (!event) throw new Error(`The ${eventName} event is not configured.`);
  const logs = [];
  for (let fromBlock = CONTRACT_START_BLOCK; fromBlock <= latestBlock;) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE - 1n < latestBlock
      ? fromBlock + LOG_BLOCK_RANGE - 1n
      : latestBlock;
    const page = await publicClient.getLogs({
      address: CONTRACT_ADDRESS,
      event,
      args: { merchant },
      fromBlock,
      toBlock,
    });
    logs.push(...page);
    fromBlock = toBlock + 1n;
  }
  return logs;
}

async function getOptionalBlockTimestamp(log, timestampCache) {
  if (log.blockNumber === null || log.blockNumber === undefined) return null;
  const key = log.blockNumber.toString();
  if (!timestampCache.has(key)) {
    timestampCache.set(key, publicClient.getBlock({ blockNumber: log.blockNumber })
      .then((block) => new Date(Number(block.timestamp) * 1000).toISOString()));
  }
  try {
    return await timestampCache.get(key);
  } catch {
    timestampCache.delete(key);
    return null;
  }
}

async function syncMerchantInvoices(merchantAddress) {
  const merchant = getAddress(merchantAddress);
  const chainId = await publicClient.getChainId();
  if (chainId !== ARC_TESTNET_ID) throw new Error('Arc Testnet could not be verified. Invoice data was not updated.');
  const latestBlock = await publicClient.getBlockNumber();
  const [createdLogs, paidLogs] = await Promise.all([
    getMerchantEventLogs('InvoiceCreated', merchant, latestBlock),
    getMerchantEventLogs('InvoicePaid', merchant, latestBlock),
  ]);
  const paidByInvoice = new Map();
  for (const log of paidLogs) {
    const args = log.args;
    if (!args?.invoiceId || args.merchant?.toLowerCase() !== merchant.toLowerCase()) continue;
    const key = args.invoiceId.toLowerCase();
    if (paidByInvoice.has(key)) throw new Error('Arc returned duplicate payment events; invoice data was not updated.');
    paidByInvoice.set(key, log);
  }

  const previousInvoices = window.arusPayApi?.getInvoices() || [];
  const previousById = new Map(previousInvoices
    .filter((item) => item.invoiceId)
    .map((item) => [item.invoiceId.toLowerCase(), item]));
  const timestampCache = new Map();
  const synced = [];
  for (const createdLog of createdLogs) {
    const created = createdLog.args;
    if (!created?.invoiceId || created.merchant?.toLowerCase() !== merchant.toLowerCase()) continue;
    const invoiceId = created.invoiceId;
    const key = invoiceId.toLowerCase();
    const known = previousById.get(key);
    const invoice = await getOnchainInvoice(merchant, invoiceId);
    if (invoice.status === STATUS.none
      || invoice.amount !== BigInt(created.amount)
      || invoice.expiresAt !== BigInt(created.expiresAt)) {
      throw new Error('Arc invoice event and current contract state do not match. Invoice data was not updated.');
    }

    const paymentLog = paidByInvoice.get(key);
    if (invoice.status === STATUS.paid) {
      if (!paymentLog || BigInt(paymentLog.args.amount) !== invoice.amount
        || paymentLog.args.merchant?.toLowerCase() !== merchant.toLowerCase()) {
        throw new Error('A paid invoice is missing its matching Arc payment event. Payment totals were not updated.');
      }
    } else if (paymentLog) {
      throw new Error('Arc returned a payment event for an invoice that is not paid. Payment totals were not updated.');
    }

    const createdAt = await getOptionalBlockTimestamp(createdLog, timestampCache);
    const paidAt = paymentLog ? await getOptionalBlockTimestamp(paymentLog, timestampCache) : null;
    const humanStatus = statusText(invoice.status, invoice.expiresAt).toLowerCase();
    synced.push({
      ...known,
      id: known?.id || `INV-${invoiceId.slice(2, 10).toUpperCase()}`,
      invoiceId,
      merchant,
      amount: Number(formatUnits(invoice.amount, 18)),
      amountBase: invoice.amount.toString(),
      due: invoice.expiresAt === 0n ? '' : new Date(Number(invoice.expiresAt) * 1000).toISOString().slice(0, 10),
      name: known?.name || 'On-chain invoice',
      description: known?.description || 'On-chain invoice',
      initials: known?.initials || 'AP',
      status: humanStatus,
      createdAt: createdAt || known?.createdAt || null,
      createTxHash: createdLog.transactionHash,
      explorerUrl: `${EXPLORER}/tx/${createdLog.transactionHash}`,
      ...(paymentLog ? {
        payer: paymentLog.args.payer,
        paidAt: paidAt || known?.paidAt || null,
        paymentTxHash: paymentLog.transactionHash,
        paymentExplorerUrl: `${EXPLORER}/tx/${paymentLog.transactionHash}`,
      } : {}),
      onchainVerified: true,
    });
  }
  return synced.reverse();
}

async function estimateFee(functionName, args, account, value) {
  const gas = await publicClient.estimateContractGas({
    account,
    address: CONTRACT_ADDRESS,
    abi: invoiceAbi,
    functionName,
    args,
    ...(value === undefined ? {} : { value }),
  });
  const gasPrice = await publicClient.getGasPrice();
  return { gas, fee: gas * gasPrice };
}

function eventArgs(receipt, eventName) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: invoiceAbi, eventName, data: log.data, topics: log.topics });
      return decoded.args;
    } catch {
      // Other events from the same transaction are ignored.
    }
  }
  return null;
}

function amountFromForm() {
  let total = 0n;
  const descriptions = [];
  for (const row of $$('.line-item')) {
    const quantityText = row.querySelector('.item-qty').value;
    if (!/^\d+$/.test(quantityText) || Number(quantityText) < 1) throw new Error('Quantity must be a positive whole number.');
    const quantity = BigInt(quantityText);
    const price = parseUsdc(row.querySelector('.item-price').value);
    total += price * quantity;
    const description = row.querySelector('.item-description').value.trim();
    if (description) descriptions.push(description);
  }
  return { total, description: descriptions.join(', ') };
}

function expirationFromForm() {
  const dueValue = $('#due-date').value;
  if (!dueValue) throw new Error('Choose an invoice due date.');
  const due = new Date(`${dueValue}T23:59:59`);
  const seconds = Math.floor(due.getTime() / 1000);
  if (!Number.isFinite(seconds) || seconds <= Math.floor(Date.now() / 1000)) {
    throw new Error('Due date must be in the future.');
  }
  return BigInt(seconds);
}

function formInvoiceMetadata() {
  const name = $('#client-name').value.trim();
  const email = $('#client-email').value.trim();
  const { total, description } = amountFromForm();
  return {
    name,
    email,
    description,
    amount: Number(formatUnits(total, 18)),
    amountBase: total.toString(),
    due: $('#due-date').value,
    initials: name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'CL',
    status: 'open',
    createdAt: new Date().toISOString(),
  };
}

async function createOnchainInvoice() {
  const form = $('#invoice-form');
  const submit = form.querySelector('[type="submit"]');
  if (!form.reportValidity()) return;
  submit.disabled = true;
  try {
    const metadata = formInvoiceMetadata();
    const expiresAt = expirationFromForm();
    const invoiceId = randomInvoiceId();
    const { account, walletClient } = await getWallet();
    const fee = await estimateFee('createInvoice', [invoiceId, BigInt(metadata.amountBase), expiresAt], account);
    showToast(`Review wallet confirmation. Estimated network fee: ${formatUsdc(fee.fee)} USDC; paid by your wallet.`);
    const hash = await walletClient.writeContract({
      account,
      address: CONTRACT_ADDRESS,
      abi: invoiceAbi,
      functionName: 'createInvoice',
      args: [invoiceId, BigInt(metadata.amountBase), expiresAt],
    });
    showToast('Invoice transaction submitted. Waiting for the Arc Testnet receipt…');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('Invoice creation reverted. No invoice was recorded in the app.');
    const created = eventArgs(receipt, 'InvoiceCreated');
    if (!created || created.invoiceId.toLowerCase() !== invoiceId.toLowerCase()
      || created.merchant.toLowerCase() !== account.toLowerCase()
      || BigInt(created.amount) !== BigInt(metadata.amountBase)) {
      throw new Error('Receipt did not contain the expected InvoiceCreated event.');
    }
    const record = {
      ...metadata,
      id: `INV-${new Date().getFullYear()}-${invoiceId.slice(2, 10).toUpperCase()}`,
      invoiceId,
      merchant: account,
      createTxHash: hash,
      explorerUrl: `${EXPLORER}/tx/${hash}`,
      onchainVerified: true,
    };
    window.arusPayApi?.addInvoice(record);
    form.reset();
    $$('.line-item').slice(1).forEach((line) => line.remove());
    const first = $$('.line-item')[0];
    first.querySelector('.item-qty').value = '1';
    first.querySelector('.item-description').value = '';
    first.querySelector('.item-price').value = '';
    window.updatePreview?.();
    showToast('Invoice confirmed on Arc Testnet.');
  } catch (error) {
    showToast(error?.shortMessage || error?.message || 'Invoice creation failed. No success is recorded without a confirmed receipt.');
  } finally {
    submit.disabled = false;
  }
}

function statusText(status, expiresAt) {
  if (status === STATUS.paid) return 'Paid';
  if (status === STATUS.cancelled) return 'Cancelled';
  if (status === STATUS.none) return 'Not found';
  if (expiresAt !== 0n && expiresAt <= BigInt(Math.floor(Date.now() / 1000))) return 'Expired';
  return 'Open';
}

function renderPaymentUnavailable(message, merchant = '', invoiceId = '') {
  const view = $('#payment-view');
  view.innerHTML = `<div class="panel payment-empty"><div class="payment-unavailable" role="status"><div class="availability-icon" aria-hidden="true">!</div><span class="eyebrow">Arc Testnet invoice</span><h1>Invoice unavailable</h1><p>${escapeHtml(message)}</p>${merchant && invoiceId ? `<div class="availability-details"><span><b>Merchant</b> ${escapeHtml(merchant)}</span><span><b>Invoice ID</b> <span class="mono">${escapeHtml(shortId(invoiceId))}</span></span></div>` : ''}<button class="btn btn-quiet" id="payment-back">Back to invoices</button></div></div>`;
  $('#payment-back')?.addEventListener('click', () => window.arusPayApi?.navigate('dashboard'));
}

async function renderPayment() {
  const requestId = ++paymentRenderRequest;
  const view = $('#payment-view');
  const selected = window.arusPayApi?.getSelectedInvoice();
  if (!selected?.merchant || !selected?.invoiceId) {
    renderPaymentUnavailable('Select an invoice or open a valid Arc Testnet payment link.');
    return;
  }
  view.innerHTML = '<div class="panel payment-empty"><div class="empty-state"><strong>Reading Arc Testnet</strong><span>Checking invoice state directly from the contract…</span></div></div>';
  try {
    const invoice = await getOnchainInvoice(selected.merchant, selected.invoiceId);
    if (requestId !== paymentRenderRequest) return;
    const status = statusText(invoice.status, invoice.expiresAt);
    if (invoice.status === STATUS.none) throw new Error('This invoice ID does not exist for the specified merchant.');
    const amount = formatUsdc(invoice.amount);
    const known = window.arusPayApi?.getInvoices().find((item) => item.invoiceId?.toLowerCase() === selected.invoiceId.toLowerCase());
    const due = invoice.expiresAt === 0n ? 'No expiry' : new Date(Number(invoice.expiresAt) * 1000).toLocaleString('en-US');
    const link = makeInvoiceLink(invoice.merchant, selected.invoiceId);
    const canPay = invoice.status === STATUS.open && status === 'Open';
    const stateClass = invoice.status === STATUS.paid ? 'paid' : invoice.status === STATUS.cancelled || status === 'Expired' ? 'overdue' : 'pending';
    view.innerHTML = `<div class="pay-crumb"><button class="table-link" id="payment-invoices">Invoices</button> <span style="color:#596578">/</span> <span class="mono">${escapeHtml(shortId(selected.invoiceId))}</span></div><div class="pay-layout"><section class="pay-main-card"><div class="pay-business"><div class="business-logo">AP</div><div><strong>ArusPay invoice</strong><span class="mono">${escapeHtml(shortId(selected.invoiceId))}</span></div></div><div class="pay-content"><span class="eyebrow">Arc Testnet · On-chain status</span><h1>${escapeHtml(status)}</h1><p>${known ? `Invoice for ${escapeHtml(known.name)}` : 'Invoice details read from Arc Testnet.'}</p><div class="pay-due"><div class="pay-due-label">${invoice.status === STATUS.paid ? 'Amount paid' : 'Amount due'}</div><div class="pay-due-amount">${escapeHtml(amount)} <span>USDC</span></div></div><div class="pay-network"><span class="chain-name"><i class="chain-icon">A</i> Arc Testnet</span><span class="status ${stateClass}">${escapeHtml(status)}</span></div><div class="availability-details"><span><b>Merchant</b> <span class="mono">${escapeHtml(invoice.merchant)}</span></span><span><b>Due / expiry</b> ${escapeHtml(due)}</span><span><b>Invoice ID</b> <span class="mono">${escapeHtml(selected.invoiceId)}</span></span></div><div class="fee-note"><span>ⓘ</span><span>Estimated fees are paid by your wallet in USDC. No gas sponsorship is used.</span></div>${canPay ? '<button class="btn btn-primary btn-full" id="pay-onchain" type="button">Pay invoice on Arc Testnet</button>' : ''}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn btn-quiet btn-sm" id="copy-invoice-link" type="button">Copy payment link</button><a class="btn btn-quiet btn-sm" href="${EXPLORER}/address/${CONTRACT_ADDRESS}" target="_blank" rel="noreferrer">View contract</a></div>${known?.createTxHash ? `<p class="hint">Creation receipt: <a class="table-link" href="${EXPLORER}/tx/${known.createTxHash}" target="_blank" rel="noreferrer">${escapeHtml(shortAddress(known.createTxHash))}</a></p>` : ''}${known?.paymentTxHash ? `<p class="hint">Payment receipt: <a class="table-link" href="${EXPLORER}/tx/${known.paymentTxHash}" target="_blank" rel="noreferrer">${escapeHtml(shortAddress(known.paymentTxHash))}</a></p>` : ''}<p class="hint">Client name, email, descriptions, and notes are not written to the contract.</p></div></section><aside class="pay-summary"><h2>Invoice summary</h2><div class="summary-row"><span>Invoice number</span><strong>${escapeHtml(known?.id || shortId(selected.invoiceId))}</strong></div><div class="summary-row"><span>Client</span><strong>${escapeHtml(known?.name || 'Invoice recipient')}</strong></div><div class="summary-row"><span>Description</span><strong>${escapeHtml(known?.description || 'On-chain invoice')}</strong></div><div class="summary-row"><span>Due date</span><strong>${escapeHtml(due)}</strong></div><div class="summary-row summary-total"><span>Total</span><strong>${escapeHtml(amount)} USDC</strong></div><div class="payment-foot">State is read from the Arc Testnet contract.</div></aside></div>`;
    const paymentButton = $('#pay-onchain');
    if (paymentButton) {
      const isPrivyWallet = ['privy', 'privy-v2'].includes(activeWalletType);
      const providerVerified = activeWalletProviderState === 'connected' && activeWalletProviderReady;
      if (!activeWalletAddress) {
        paymentButton.textContent = 'Connect wallet to pay';
      } else if (activeWalletProviderState === 'checking') {
        paymentButton.textContent = isPrivyWallet ? 'Checking Privy connection…' : 'Checking wallet network…';
      } else if (!providerVerified) {
        paymentButton.textContent = 'Wallet network not verified';
      }
      const walletHint = document.createElement('p');
      walletHint.className = 'hint';
      walletHint.setAttribute('role', 'status');
      walletHint.textContent = !activeWalletAddress
        ? 'Invoice status is read from the ArusPay contract. Connect an Ethereum wallet to pay.'
        : activeWalletProviderState === 'checking'
          ? `Checking the ${isPrivyWallet ? 'Privy ' : ''}wallet provider and verifying Arc Testnet (chain ID ${ARC_TESTNET_ID}) using a read-only request. No signature or transaction has been requested.`
          : !providerVerified
            ? activeWalletProviderError || 'The wallet provider and Arc Testnet network have not been verified. Tap Retry to repeat the read-only check. No signature or transaction has been requested.'
            : isPrivyWallet
              ? 'The Privy provider answered a read-only Arc Testnet network check. Signing has not been tested here; no signature or transaction has been requested.'
              : `Wallet provider for ${shortAddress(activeWalletAddress)} answered a read-only Arc Testnet network check. No signature or transaction has been requested.`;
      paymentButton.before(walletHint);
      if (activeWalletAddress && !providerVerified) {
        paymentButton.disabled = true;
        if (activeWalletProviderState !== 'checking') {
          const retryButton = document.createElement('button');
          retryButton.className = 'btn btn-quiet btn-sm';
          retryButton.id = 'retry-wallet-connection';
          retryButton.type = 'button';
          retryButton.textContent = isPrivyWallet ? 'Retry Privy connection' : 'Retry wallet connection';
          retryButton.addEventListener('click', () => void checkActiveWalletProvider(activeWalletAddress, activeWalletType));
          paymentButton.after(retryButton);
        }
      }
    }
    $('#payment-invoices')?.addEventListener('click', () => window.arusPayApi?.navigate('dashboard'));
    $('#copy-invoice-link')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        showToast('Payment link copied. It contains no client personal information.');
      } catch {
        showToast(`Copy this link: ${link}`);
      }
    });
    paymentButton?.addEventListener('click', () => {
      if (activeWalletAddress && (activeWalletProviderState !== 'connected' || !activeWalletProviderReady)) return;
      if (!activeWalletAddress && !window.ethereum?.request) {
        if (window.arusPayPrivy?.login) {
          void window.arusPayPrivy.login('wallet');
        } else {
          showToast('Wallet connection is still loading. Try again shortly; no transaction was sent.');
        }
        return;
      }
      void payInvoice(invoice.merchant, selected.invoiceId, invoice.amount);
    });
  } catch (error) {
    if (requestId !== paymentRenderRequest) return;
    renderPaymentUnavailable(error?.shortMessage || error?.message || 'The invoice could not be read from Arc Testnet.', selected.merchant, selected.invoiceId);
  }
}

async function payInvoice(merchant, invoiceId, amount) {
  const button = $('#pay-onchain');
  if (button) button.disabled = true;
  try {
    const { account, walletClient } = await getWallet();
    const current = await getOnchainInvoice(merchant, invoiceId);
    if (current.status !== STATUS.open) throw new Error(`This invoice is ${statusText(current.status, current.expiresAt).toLowerCase()} and cannot be paid.`);
    if (current.expiresAt !== 0n && current.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('This invoice has expired.');
    const fee = await estimateFee('payInvoice', [getAddress(merchant), invoiceId], account, amount);
    showToast(`Review wallet confirmation for ${formatUsdc(amount)} USDC plus an estimated ${formatUsdc(fee.fee)} USDC network fee.`);
    const hash = await walletClient.writeContract({
      account,
      address: CONTRACT_ADDRESS,
      abi: invoiceAbi,
      functionName: 'payInvoice',
      args: [getAddress(merchant), invoiceId],
      value: amount,
    });
    showToast('Payment submitted. Waiting for the Arc Testnet receipt…');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('Payment reverted. The invoice remains unpaid.');
    const paid = eventArgs(receipt, 'InvoicePaid');
    if (!paid || paid.invoiceId.toLowerCase() !== invoiceId.toLowerCase()
      || paid.merchant.toLowerCase() !== merchant.toLowerCase()
      || paid.payer.toLowerCase() !== account.toLowerCase()
      || BigInt(paid.amount) !== current.amount) {
      throw new Error('Receipt did not contain the expected InvoicePaid event.');
    }
    const after = await getOnchainInvoice(merchant, invoiceId);
    if (after.status !== STATUS.paid) throw new Error('Payment event was found, but the contract state is not Paid.');
    window.arusPayApi?.updateInvoice(invoiceId, {
      status: 'paid',
      paidAt: new Date().toISOString(),
      payer: account,
      paymentTxHash: hash,
      paymentExplorerUrl: `${EXPLORER}/tx/${hash}`,
      onchainVerified: true,
    });
    await renderPayment();
    showToast('Payment confirmed on Arc Testnet.');
  } catch (error) {
    showToast(error?.shortMessage || error?.message || 'Payment failed. No paid state is shown without a matching receipt and event.');
    await renderPayment();
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function openSharedInvoice(merchant, invoiceId) {
  try {
    const safeMerchant = getAddress(merchant);
    if (!/^0x[0-9a-fA-F]{64}$/.test(invoiceId)) throw new Error('The payment link has an invalid invoice ID.');
    const id = `INV-${invoiceId.slice(2, 10).toUpperCase()}`;
    window.arusPayApi?.openInvoice({
      id,
      invoiceId,
      merchant: safeMerchant,
    });
  } catch (error) {
    $('#signin').classList.add('hidden');
    $('#workspace').classList.add('hidden');
    $('#payment').classList.remove('hidden');
    renderPaymentUnavailable(error?.shortMessage || error?.message || 'This payment link could not be read from Arc Testnet.', merchant, invoiceId);
  }
}

window.arusPayUpdatePayment = renderPayment;
window.arusPayCreateInvoice = createOnchainInvoice;
let activeWalletAddress = null;
let activeWalletType = '';
let activeWalletProviderReady = false;
let activeWalletProviderState = 'disconnected';
let activeWalletProviderError = '';
let walletProviderProbeRequest = 0;
let paymentRenderRequest = 0;
let dashboardSyncRequest = 0;

function setWalletBalance(value, message, error = '') {
  const balance = $('#wallet-balance');
  const status = $('#wallet-balance-state');
  const profileBalance = $('#profile-wallet-balance');
  const profileStatus = $('#profile-wallet-balance-state');
  const profileAddress = $('#profile-wallet-address');
  if (balance) balance.textContent = value;
  if (status) {
    status.textContent = message;
    status.title = error;
  }
  if (profileBalance) profileBalance.textContent = value;
  if (profileStatus) {
    profileStatus.textContent = message;
    profileStatus.title = error;
  }
  if (profileAddress) profileAddress.textContent = activeWalletAddress || 'Not connected';
}

function setInvoiceSyncStatus(message, error = '') {
  const status = $('#invoice-sync-status');
  if (!status) return;
  status.textContent = message;
  status.title = error;
}

async function checkActiveWalletProvider(address = activeWalletAddress, walletClientType = activeWalletType) {
  if (!address) return false;
  const request = ++walletProviderProbeRequest;
  const deadline = Date.now() + 12_000;
  const expectedAddress = address.toLowerCase();
  activeWalletProviderReady = false;
  activeWalletProviderState = 'checking';
  activeWalletProviderError = '';
  if (!$('#payment').classList.contains('hidden') && window.arusPayApi?.getSelectedInvoice()) {
    void renderPayment();
  }
  try {
    const providerLookupRemaining = deadline - Date.now();
    if (providerLookupRemaining <= 0) throw new Error('Privy provider lookup timed out.');
    const provider = await withTimeout(
      () => window.arusPayPrivy?.getEthereumProvider?.({ address, walletClientType }),
      providerLookupRemaining,
      'Privy provider lookup timed out.',
    );
    if (!provider?.request) throw new Error('No connected wallet provider was returned.');
    const chainCheckRemaining = deadline - Date.now();
    if (chainCheckRemaining <= 0) throw new Error('Privy read-only connection check timed out.');
    const chainId = await withTimeout(
      () => provider.request({ method: 'eth_chainId' }),
      chainCheckRemaining,
      'Privy read-only connection check timed out.',
    );
    if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId)) {
      throw new Error('The wallet provider did not return a valid chain ID.');
    }
    if (!isExpectedHexChainId(chainId, ARC_TESTNET_ID)) {
      throw new Error('The connected wallet is not on Arc Testnet.');
    }
    if (request !== walletProviderProbeRequest || activeWalletAddress?.toLowerCase() !== expectedAddress) return false;
    activeWalletProviderReady = true;
    activeWalletProviderState = 'connected';
  } catch (error) {
    if (request !== walletProviderProbeRequest || activeWalletAddress?.toLowerCase() !== expectedAddress) return false;
    activeWalletProviderReady = false;
    activeWalletProviderState = 'unavailable';
    const retryAction = ['privy', 'privy-v2'].includes(walletClientType) ? 'Retry Privy connection' : 'Retry wallet connection';
    if (error?.message === 'Privy provider lookup timed out.') {
      activeWalletProviderError = `The ${['privy', 'privy-v2'].includes(walletClientType) ? 'Privy ' : ''}wallet provider was not returned within 12 seconds. Tap ${retryAction} to repeat this read-only check. No signature or transaction was requested.`;
    } else if (error?.message === 'Privy read-only connection check timed out.') {
      activeWalletProviderError = `The wallet provider did not answer the Arc Testnet network check within 12 seconds. Tap ${retryAction} to repeat it. No signature or transaction was requested.`;
    } else if (error?.message === 'The connected wallet is not on Arc Testnet.') {
      activeWalletProviderError = `The connected wallet is not on Arc Testnet (chain ID ${ARC_TESTNET_ID}). Switch to Arc Testnet, then tap ${retryAction}. No signature or transaction was requested.`;
    } else if (error?.message === 'The wallet provider did not return a valid chain ID.') {
      activeWalletProviderError = `The wallet provider returned an invalid network ID. Reconnect it, then tap ${retryAction}. No signature or transaction was requested.`;
    } else {
      activeWalletProviderError = `The connected wallet provider could not be verified on Arc Testnet. Tap ${retryAction} to repeat the read-only check. No signature or transaction was requested.`;
    }
  }
  if (!$('#payment').classList.contains('hidden') && window.arusPayApi?.getSelectedInvoice()) {
    void renderPayment();
  }
  return activeWalletProviderReady;
}

async function refreshArcDashboard(address = activeWalletAddress) {
  if (!address) return;
  const safeAddress = getAddress(address);
  activeWalletAddress = safeAddress;
  const request = ++dashboardSyncRequest;
  const refreshButtons = [$('#refresh-chain-sync'), $('#profile-refresh-chain-sync')].filter(Boolean);
  refreshButtons.forEach((button) => { button.disabled = true; });
  setWalletBalance('—', 'Reading Arc Testnet…');
  setInvoiceSyncStatus('Syncing invoice events from Arc Testnet…');
  window.arusPayApi?.setInvoiceSyncState('loading');

  const verifiedChain = publicClient.getChainId().then((chainId) => {
    if (chainId !== ARC_TESTNET_ID) throw new Error('The RPC endpoint returned an unexpected chain ID.');
  });
  const [balanceResult, invoicesResult] = await Promise.allSettled([
    verifiedChain.then(() => publicClient.getBalance({ address: safeAddress })),
    verifiedChain.then(() => syncMerchantInvoices(safeAddress)),
  ]);
  if (request !== dashboardSyncRequest) return;

  if (balanceResult.status === 'fulfilled') {
    setWalletBalance(formatUsdc(balanceResult.value), 'Native USDC balance · Arc Testnet');
  } else {
    const message = balanceResult.reason?.shortMessage || balanceResult.reason?.message || 'Arc Testnet balance could not be read.';
    setWalletBalance('—', 'Balance unavailable · refresh to retry', message);
  }

  if (invoicesResult.status === 'fulfilled') {
    const syncedInvoices = invoicesResult.value;
    window.arusPayApi?.replaceInvoices(syncedInvoices);
    setInvoiceSyncStatus(syncedInvoices.length
      ? `${syncedInvoices.length} invoice${syncedInvoices.length === 1 ? '' : 's'} synced from Arc Testnet.`
      : 'No invoice events found for this wallet on Arc Testnet.');
  } else {
    const message = invoicesResult.reason?.shortMessage || invoicesResult.reason?.message || 'Arc Testnet invoices could not be read.';
    setInvoiceSyncStatus('Invoice sync unavailable · refresh to retry', message);
    window.arusPayApi?.setInvoiceSyncState('error');
  }

  refreshButtons.forEach((button) => { button.disabled = false; });
}

window.arusPayRefreshSync = () => refreshArcDashboard();
['#refresh-chain-sync', '#profile-refresh-chain-sync'].forEach((selector) => {
  $(selector)?.addEventListener('click', () => {
    if (activeWalletAddress) void refreshArcDashboard(activeWalletAddress);
  });
});

window.arusPayWalletChanged = (wallets = []) => {
  const wallet = wallets.find((item) => item.chainType === 'ethereum' || item.chainType === 'evm');
  if (wallet?.address) {
    try {
      const nextAddress = getAddress(wallet.address);
      if (activeWalletAddress && activeWalletAddress.toLowerCase() !== nextAddress.toLowerCase()) {
        window.arusPayApi?.clearInvoices(new URL(window.location.href).searchParams.has('invoiceId'));
      }
      activeWalletAddress = nextAddress;
      activeWalletType = wallet.walletClientType || '';
      activeWalletProviderReady = false;
      activeWalletProviderState = 'checking';
      activeWalletProviderError = '';
      showWalletStatus(activeWalletAddress);
      void checkActiveWalletProvider(activeWalletAddress, activeWalletType);
      void refreshArcDashboard(activeWalletAddress);
    } catch {
      walletProviderProbeRequest += 1;
      activeWalletAddress = null;
      activeWalletType = '';
      activeWalletProviderReady = false;
      activeWalletProviderState = 'disconnected';
      activeWalletProviderError = '';
      dashboardSyncRequest += 1;
      setWalletBalance('—', 'Privy returned an invalid wallet address.');
      setInvoiceSyncStatus('Invoice sync unavailable · check the connected wallet.');
      window.arusPayApi?.setInvoiceSyncState('error');
      ['#refresh-chain-sync', '#profile-refresh-chain-sync'].forEach((selector) => {
        const button = $(selector);
        if (button) button.disabled = false;
      });
    }
    if (!$('#payment').classList.contains('hidden') && window.arusPayApi?.getSelectedInvoice()) {
      void renderPayment();
    }
    return;
  }
  walletProviderProbeRequest += 1;
  activeWalletAddress = null;
  activeWalletType = '';
  activeWalletProviderReady = false;
  activeWalletProviderState = 'disconnected';
  activeWalletProviderError = '';
  dashboardSyncRequest += 1;
  window.arusPayApi?.setInvoiceSyncState('disconnected');
  ['#refresh-chain-sync', '#profile-refresh-chain-sync'].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = false;
  });
  showWalletStatus('', window.arusPayAuthenticatedState ? 'Wallet not connected' : '');
  setWalletBalance('—', 'Connect a Privy wallet to read its balance.');
  setInvoiceSyncStatus('Connect a Privy wallet to sync Arc invoices.');
  if (!$('#payment').classList.contains('hidden') && window.arusPayApi?.getSelectedInvoice()) {
    void renderPayment();
  }
};

const url = new URL(window.location.href);
const linkedMerchant = url.searchParams.get('merchant');
const linkedInvoice = url.searchParams.get('invoiceId');
if (linkedMerchant && linkedInvoice) openSharedInvoice(linkedMerchant, linkedInvoice);

window.arusPayConfig = {
  chainId: ARC_TESTNET_ID,
  rpcUrl: ARC_RPC,
  contractAddress: CONTRACT_ADDRESS,
  explorerUrl: EXPLORER,
};
