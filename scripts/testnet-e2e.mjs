import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, parseUnits } from 'viem';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RPC = process.env.ARUSPAY_TESTNET_RPC_URL || 'https://rpc.blockdaemon.testnet.arc.io';
const CHAIN_ID = 5042002;
const CONTRACT = getAddress('0x0cc3b91Fc603Ef15d80B3C0e8DB222e5988b8926');
const AMOUNT = parseUnits('0.10', 18);
const EXPLORER = 'https://explorer.testnet.arc.io';
const APP_URL = 'https://termul.xyz/';
const KEYSTORE = process.env.ARUSPAY_TEST_KEYSTORE;
const PASSWORD_FILE = process.env.ARUSPAY_TEST_PASSWORD_FILE;
const CAST = process.env.ARC_CAST_BIN || '/home/ubuntu/.local/bin/arc-cast';
const RESULT_PATH = process.env.ARUSPAY_E2E_RESULT || '/tmp/aruspay-testnet-e2e-result.json';
const TRACE = process.env.ARUSPAY_E2E_TRACE === '1';
const DRY_RUN = process.env.ARUSPAY_E2E_DRY_RUN === '1';
const submissions = [];
let merchant;
let createdInvoiceId;

if (!KEYSTORE || !PASSWORD_FILE) {
  throw new Error('Set ARUSPAY_TEST_KEYSTORE and ARUSPAY_TEST_PASSWORD_FILE. This test sends real Arc Testnet transactions.');
}

try {
  const prior = JSON.parse(await readFile(RESULT_PATH, 'utf8'));
  if (prior.submissions?.length || prior.createTxHash || prior.paymentTxHash) {
    throw new Error('A prior run has submitted transactions. Inspect its result before choosing a new result path; do not blindly rerun.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const { stdout } = await exec('curl', [
    '--fail', '--silent', '--show-error', '--compressed', '--max-time', '30',
    '-H', 'Content-Type: application/json', '--data-binary', body, RPC,
  ], { maxBuffer: 4 * 1024 * 1024, timeout: 35000 });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(`${method}: ${response.error.message}`);
  return response.result;
}

async function saveRecovery(extra = {}) {
  await writeFile(RESULT_PATH, `${JSON.stringify({ chainId: CHAIN_ID, contract: CONTRACT, merchant, submissions, ...extra }, null, 2)}\n`, { mode: 0o600 });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const artifact = JSON.parse(await readFile(`${ROOT}contracts/out/ArusPayInvoices.sol/ArusPayInvoices.json`, 'utf8'));
const abi = artifact.abi;
const addressOutput = await exec(CAST, ['wallet', 'address', '--keystore', KEYSTORE, '--password-file', PASSWORD_FILE], { timeout: 30000 });
merchant = getAddress(addressOutput.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0] || '');
if (Number(BigInt(await rpc('eth_chainId', []))) !== CHAIN_ID) throw new Error('Wrong RPC chain; no transactions were sent.');
const code = await rpc('eth_getCode', [CONTRACT, 'latest']);
const expectedCode = artifact.deployedBytecode.object.startsWith('0x') ? artifact.deployedBytecode.object : `0x${artifact.deployedBytecode.object}`;
if (code.toLowerCase() !== expectedCode.toLowerCase()) throw new Error('Deployed contract bytecode does not match the reviewed artifact.');
const balanceBefore = BigInt(await rpc('eth_getBalance', [merchant, 'latest']));
if (balanceBefore < AMOUNT + parseUnits('0.05', 18)) throw new Error('Insufficient Arc Testnet USDC for the bounded test.');

const allowedReadMethods = new Set([
  'eth_chainId', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_estimateGas', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_blockNumber',
  'eth_getBlockByNumber', 'eth_call', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
]);

const provider = {
  async request({ method, params = [] }) {
    if (TRACE) console.log(`E2E provider request: ${method}`);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [merchant];
    if (method === 'wallet_switchEthereumChain') {
      if (Number(BigInt(params[0]?.chainId || '0x0')) !== CHAIN_ID) throw new Error('Only Arc Testnet is permitted.');
      return null;
    }
    if (method === 'eth_sendTransaction') {
      if (submissions.length >= 2) throw new Error('The E2E signer permits only one create and one pay transaction.');
      const tx = params[0];
      if (TRACE) console.log('E2E transaction request summary:', JSON.stringify({
        keys: Object.keys(tx || {}), from: tx?.from, to: tx?.to, chainId: tx?.chainId,
        dataPrefix: typeof tx?.data === 'string' ? tx.data.slice(0, 10) : null,
        dataLength: typeof tx?.data === 'string' ? tx.data.length : null, value: tx?.value,
      }));
      if (getAddress(tx.to) !== CONTRACT || getAddress(tx.from) !== merchant) throw new Error('Unexpected test transaction sender or target.');
      if (tx.chainId && Number(BigInt(tx.chainId)) !== CHAIN_ID) throw new Error('Unexpected transaction chain.');
      const decoded = decodeFunctionData({ abi, data: tx.data });
      const value = BigInt(tx.value || '0x0');
      if (submissions.length === 0) {
        if (decoded.functionName !== 'createInvoice' || decoded.args[1] !== AMOUNT || value !== 0n) throw new Error('Unexpected invoice creation payload.');
        createdInvoiceId = decoded.args[0];
      } else if (decoded.functionName !== 'payInvoice'
        || getAddress(decoded.args[0]) !== merchant
        || decoded.args[1] !== createdInvoiceId
        || value !== AMOUNT) {
        throw new Error('Unexpected invoice payment payload.');
      }
      if (Number(BigInt(await rpc('eth_chainId', []))) !== CHAIN_ID) throw new Error('RPC chain changed; signing stopped.');
      if (TRACE) console.log('E2E decoded transaction:', JSON.stringify({ functionName: decoded.functionName, amountBase: (decoded.functionName === 'createInvoice' ? decoded.args[1] : decoded.args[1])?.toString(), valueBase: value.toString() }));
      if (DRY_RUN) throw new Error('Dry run blocked before signing or transaction submission.');
      const args = [
        'send', CONTRACT, '--data', tx.data, '--value', value.toString(),
        '--rpc-url', RPC, '--keystore', KEYSTORE, '--password-file', PASSWORD_FILE,
        '--async', '--rpc-timeout', '30',
      ];
      let stdout = '';
      try {
        ({ stdout } = await exec(CAST, args, { timeout: 90000, maxBuffer: 1024 * 1024 }));
      } catch (error) {
        const uncertainHash = String(error.stdout || '').match(/0x[0-9a-fA-F]{64}/)?.[0];
        if (TRACE) console.error('arc-cast send stderr:', String(error.stderr || '').replace(/0x[0-9a-fA-F]{64,}/g, '[hex omitted]').slice(-1500));
        if (uncertainHash) submissions.push({ functionName: decoded.functionName, hash: uncertainHash, uncertain: true });
        await saveRecovery({ error: 'Transaction submission did not return cleanly. Inspect existing transactions before retrying.' });
        throw new Error('Transaction submission did not return cleanly; no automatic retry will be attempted.');
      }
      const hash = stdout.match(/0x[0-9a-fA-F]{64}/)?.[0];
      if (!hash) throw new Error('No transaction hash returned. Inspect the account nonce before retrying.');
      submissions.push({ functionName: decoded.functionName, hash });
      await saveRecovery();
      console.log(`${decoded.functionName} submitted: ${hash}`);
      return hash;
    }
    if (!allowedReadMethods.has(method)) throw new Error(`Unsupported test signer method: ${method}`);
    return rpc(method, params);
  },
};

// The test transport forwards public RPC requests through curl with normal TLS
// verification. Signing remains exclusively in arc-cast's encrypted keystore.
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url !== RPC && url !== `${RPC}/`) throw new Error('The E2E transport only permits the official Arc Testnet RPC.');
  const body = typeof init.body === 'string' ? init.body : await input.text();
  const request = JSON.parse(body);
  const requests = Array.isArray(request) ? request : [request];
  if (requests.some((item) => !allowedReadMethods.has(item.method))) throw new Error('Unexpected public RPC write request.');
  const { stdout } = await exec('curl', [
    '--fail', '--silent', '--show-error', '--compressed', '--max-time', '30',
    '-H', 'Content-Type: application/json', '--data-binary', body, RPC,
  ], { maxBuffer: 4 * 1024 * 1024, timeout: 35000 });
  return new Response(stdout, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const html = await readFile(`${ROOT}index.html`, 'utf8');
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => console.error(`DOM test error: ${error.message}`));
const dom = new JSDOM(html, { url: APP_URL, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
window.arusPayPrivy = { getEthereumProvider: async () => provider };
window.arusPayWallets = [{ chainType: 'ethereum', address: merchant }];
window.arusPayAuthenticatedState = true;
await import(pathToFileURL(`${ROOT}src/arc-invoices.js`).href);
if (window.arusPayConfig.chainId !== CHAIN_ID || getAddress(window.arusPayConfig.contractAddress) !== CONTRACT) {
  throw new Error('Frontend configuration differs from the permitted testnet deployment.');
}

try {
  window.arusPayApi.navigate('create');
  document.querySelector('#client-name').value = 'Arc Testnet validation';
  document.querySelector('#client-email').value = 'validation@aruspay.invalid';
  document.querySelector('.item-description').value = 'Explicit Arc Testnet end-to-end validation';
  document.querySelector('.item-qty').value = '1';
  document.querySelector('.item-price').value = '0.10';
  document.querySelector('#due-date').value = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  console.log('Executing the frontend createInvoice flow on Arc Testnet…');
  await window.arusPayCreateInvoice();
  const invoice = window.arusPayApi.getInvoices()[0];
  if (!invoice?.createTxHash) throw new Error(`Frontend did not record a confirmed creation: ${document.querySelector('#toast-text').textContent}`);
  const payButton = await waitFor(() => document.querySelector('#pay-onchain'), 60000, 'the on-chain payment view');
  console.log('Executing the frontend payInvoice flow on Arc Testnet…');
  payButton.click();
  await waitFor(() => invoice.status === 'paid', 180000, 'the frontend Paid state');
  const createReceipt = await rpc('eth_getTransactionReceipt', [invoice.createTxHash]);
  const paymentReceipt = await rpc('eth_getTransactionReceipt', [invoice.paymentTxHash]);
  const paymentTx = await rpc('eth_getTransactionByHash', [invoice.paymentTxHash]);
  if (createReceipt.status !== '0x1' || paymentReceipt.status !== '0x1') throw new Error('A test receipt did not succeed.');
  if (BigInt(paymentTx.value) !== AMOUNT || getAddress(paymentTx.to) !== CONTRACT) throw new Error('Payment value or target mismatch.');
  const findEvent = (receipt, eventName) => receipt.logs.filter((log) => getAddress(log.address) === CONTRACT).map((log) => {
    try { return decodeEventLog({ abi, eventName, data: log.data, topics: log.topics }).args; } catch { return null; }
  }).find(Boolean);
  const created = findEvent(createReceipt, 'InvoiceCreated');
  const paid = findEvent(paymentReceipt, 'InvoicePaid');
  if (!created || !paid || created.invoiceId !== invoice.invoiceId || paid.invoiceId !== invoice.invoiceId
    || getAddress(created.merchant) !== merchant || getAddress(paid.merchant) !== merchant
    || getAddress(paid.payer) !== merchant || created.amount !== AMOUNT || paid.amount !== AMOUNT) {
    throw new Error('Independent receipt/event validation failed.');
  }
  const stateData = encodeFunctionData({ abi, functionName: 'getInvoice', args: [merchant, invoice.invoiceId] });
  const rawState = await rpc('eth_call', [{ to: CONTRACT, data: stateData }, 'latest']);
  const state = decodeFunctionResult({ abi, functionName: 'getInvoice', data: rawState });
  if (Number(state.status) !== 2 || state.amount !== AMOUNT || getAddress(state.merchant) !== merchant) throw new Error('Final contract state is not the expected Paid invoice.');
  const balanceAfter = BigInt(await rpc('eth_getBalance', [merchant, 'latest']));
  const contractBalance = BigInt(await rpc('eth_getBalance', [CONTRACT, 'latest']));
  const gasFees = BigInt(createReceipt.gasUsed) * BigInt(createReceipt.effectiveGasPrice)
    + BigInt(paymentReceipt.gasUsed) * BigInt(paymentReceipt.effectiveGasPrice);
  const paymentLink = new URL(APP_URL);
  paymentLink.searchParams.set('merchant', merchant);
  paymentLink.searchParams.set('invoiceId', invoice.invoiceId);
  const result = {
    verified: true,
    testMode: 'Actual frontend module with a restricted EIP-1193 encrypted-keystore signer',
    chainId: CHAIN_ID,
    contract: CONTRACT,
    merchant,
    payer: merchant,
    payerSameAsMerchant: true,
    invoiceId: invoice.invoiceId,
    amountUsdc: '0.10',
    amountBase: AMOUNT.toString(),
    createTxHash: invoice.createTxHash,
    paymentTxHash: invoice.paymentTxHash,
    createExplorerUrl: `${EXPLORER}/tx/${invoice.createTxHash}`,
    paymentExplorerUrl: `${EXPLORER}/tx/${invoice.paymentTxHash}`,
    invoiceStatus: 'Paid',
    invoiceStatusValue: Number(state.status),
    eventsVerified: ['InvoiceCreated', 'InvoicePaid'],
    gasFeesUsdc: formatUnits(gasFees, 18),
    walletBalanceBeforeUsdc: formatUnits(balanceBefore, 18),
    walletBalanceAfterUsdc: formatUnits(balanceAfter, 18),
    contractBalanceUsdc: formatUnits(contractBalance, 18),
    paymentLink: paymentLink.toString(),
    submissions,
  };
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await saveRecovery({ error: error.message });
  throw error;
} finally {
  dom.window.close();
}
