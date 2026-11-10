import assert from 'node:assert/strict';
import {
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseUnits,
} from 'viem';
import {
  broadcastSignedTransactionOnce,
  createPaymentSubmissionGate,
} from '../src/payment-result.js';
import {
  matchesInvoiceCreationTransaction,
  pollInvoiceCreationReconciliation,
  reconcileInvoiceCreationAttempt,
  submitInvoiceCreationOnce,
} from '../src/invoice-creation.js';

const chainId = 5042002;
const contract = '0x0cc3b91fc603ef15d80b3c0e8db222e5988b8926';
const merchant = '0x4d3e3dc6d280cdd8ba520f8e4b9ac3bf762bbdfe';
const invoiceId = `0x${'ab'.repeat(32)}`;
const amount = parseUnits('5', 18);
const expiresAt = 1_794_329_999n;
const signedTransaction = '0x02f86c';
const hash = keccak256(signedTransaction);
const abi = [
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
];
const expected = { chainId, contract, merchant, invoiceId, amount, expiresAt, abi };
const calldata = encodeFunctionData({ abi, functionName: 'createInvoice', args: [invoiceId, amount, expiresAt] });
const transaction = { hash, from: merchant, to: contract, input: calldata, value: 0n, chainId };
const eventTopics = encodeEventTopics({ abi, eventName: 'InvoiceCreated', args: { invoiceId, merchant } });
const eventData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [amount, expiresAt]);
const createdLog = {
  address: contract,
  transactionHash: hash,
  topics: eventTopics,
  data: eventData,
};
const successfulReceipt = {
  transactionHash: hash,
  status: 'success',
  logs: [createdLog],
};
const readDeps = {
  readChainId: async () => chainId,
  readReceipt: async () => successfulReceipt,
  readTransaction: async () => transaction,
};

{
  assert.equal(matchesInvoiceCreationTransaction(transaction, expected), true, 'Exact createInvoice calldata, sender, contract, value and chain are accepted.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, from: '0x1111111111111111111111111111111111111111' }, expected), false, 'A different merchant/sender is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, value: 1n }, expected), false, 'Unexpected native value is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, input: encodeFunctionData({ abi, functionName: 'createInvoice', args: [invoiceId, amount + 1n, expiresAt] }) }, expected), false, 'A different amount is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, input: encodeFunctionData({ abi, functionName: 'createInvoice', args: [`0x${'cd'.repeat(32)}`, amount, expiresAt] }) }, expected), false, 'A different invoice ID is rejected.');
  assert.equal(matchesInvoiceCreationTransaction({ ...transaction, input: encodeFunctionData({ abi, functionName: 'createInvoice', args: [invoiceId, amount, expiresAt + 1n] }) }, expected), false, 'A different expiry is rejected.');
}

{
  const signingChain = defineChain({
    id: chainId,
    name: 'Arc Testnet mock',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.invalid.test'] } },
  });
  const walletMethods = [];
  const walletClient = createWalletClient({
    account: merchant,
    chain: signingChain,
    transport: custom({
      request: async ({ method, params }) => {
        walletMethods.push(method);
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'eth_signTransaction') {
          assert.equal(params[0].from.toLowerCase(), merchant);
          assert.equal(params[0].to.toLowerCase(), contract);
          assert.equal(params[0].data.toLowerCase(), calldata.toLowerCase());
          assert.equal(BigInt(params[0].value ?? 0), 0n);
          return signedTransaction;
        }
        throw new Error(`Unexpected wallet RPC method: ${method}`);
      },
    }),
  });
  let broadcastCount = 0;
  let waitHash = null;
  const attempt = await submitInvoiceCreationOnce({
    submit: async () => {
      const serialized = await walletClient.signTransaction({
        account: merchant,
        chain: signingChain,
        to: contract,
        data: calldata,
        value: 0n,
        nonce: 8,
        gas: 180000n,
        maxFeePerGas: 24_000_000_000n,
        maxPriorityFeePerGas: 0n,
      });
      return broadcastSignedTransactionOnce({
        serializedTransaction: serialized,
        broadcast: async (raw) => {
          broadcastCount += 1;
          assert.equal(raw, signedTransaction, 'The exact signed bytes are broadcast unchanged.');
          throw new Error('already known: nonce too low: next nonce 9, tx nonce 8');
        },
      });
    },
    waitForReceipt: async (transactionHash) => {
      waitHash = transactionHash;
      return successfulReceipt;
    },
    reconcile: (args) => reconcileInvoiceCreationAttempt({ expected, ...args, ...readDeps }),
  });
  assert.equal(attempt.transactionHash, hash, 'The precomputed hash is retained when RPC says already known / nonce too low.');
  assert.equal(waitHash, hash, 'Receipt waiting continues against the precomputed hash despite the broadcast error.');
  assert.equal(attempt.result.status, 'created', 'Only a successful exact receipt and matching InvoiceCreated event confirm creation.');
  assert.equal(attempt.result.transactionHash, hash);
  assert.equal(attempt.ambiguous, true, 'The RPC error remains marked ambiguous even though reconciliation proves success.');
  assert.equal(broadcastCount, 1, 'The raw signed transaction is broadcast exactly once.');
  assert.deepEqual(walletMethods, ['eth_chainId', 'eth_signTransaction'], 'Privy signs only; no wallet eth_sendTransaction is used.');
}

{
  const wrongEvents = [
    {
      label: 'invoice ID',
      log: { ...createdLog, topics: encodeEventTopics({ abi, eventName: 'InvoiceCreated', args: { invoiceId: `0x${'cd'.repeat(32)}`, merchant } }) },
    },
    {
      label: 'merchant',
      log: { ...createdLog, topics: encodeEventTopics({ abi, eventName: 'InvoiceCreated', args: { invoiceId, merchant: '0x1111111111111111111111111111111111111111' } }) },
    },
    {
      label: 'amount',
      log: { ...createdLog, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [amount + 1n, expiresAt]) },
    },
  ];
  for (const { label, log } of wrongEvents) {
    const result = await reconcileInvoiceCreationAttempt({
      expected,
      transactionHash: hash,
      readChainId: async () => chainId,
      readReceipt: async () => ({ ...successfulReceipt, logs: [log] }),
      readTransaction: async () => transaction,
    });
    assert.equal(result.status, 'unmatched', `A receipt with a mismatched InvoiceCreated ${label} never marks the invoice successful.`);
  }
}

{
  let transactionReads = 0;
  const reconcile = () => reconcileInvoiceCreationAttempt({
    expected,
    transactionHash: hash,
    readChainId: async () => chainId,
    readReceipt: async () => successfulReceipt,
    readTransaction: async () => (++transactionReads < 3 ? null : transaction),
  });
  const initialResult = await reconcile();
  assert.equal(initialResult.status, 'pending', 'A receipt alone remains pending while the RPC transaction lookup lags.');
  const delayed = await pollInvoiceCreationReconciliation({
    initialResult,
    reconcile,
    intervalMs: 0,
    maxAttempts: 5,
    sleep: async () => {},
  });
  assert.equal(delayed.status, 'created', 'A successful exact receipt/event is accepted once its matching transaction becomes visible.');
  assert.equal(transactionReads, 3);
}

{
  let submitCount = 0;
  let readCount = 0;
  const delayed = await pollInvoiceCreationReconciliation({
    initialResult: { status: 'pending', transactionHash: hash, ambiguous: true },
    reconcile: async () => {
      readCount += 1;
      return readCount < 3
        ? { status: 'pending', transactionHash: hash, ambiguous: true }
        : { status: 'created', transactionHash: hash };
    },
    intervalMs: 0,
    maxAttempts: 5,
    sleep: async () => {},
  });
  assert.equal(delayed.status, 'created', 'Read-only polling recognizes a receipt that becomes visible later without a page refresh.');
  assert.equal(readCount, 3);
  assert.equal(submitCount, 0, 'Polling never calls a submit function.');
}

{
  let submitCount = 0;
  let waitCount = 0;
  const attempt = await submitInvoiceCreationOnce({
    submit: async () => {
      submitCount += 1;
      throw Object.assign(new Error('User rejected request'), { code: 4001 });
    },
    waitForReceipt: async () => { waitCount += 1; throw new Error('Must not wait without a hash.'); },
    reconcile: (args) => reconcileInvoiceCreationAttempt({ expected, ...args, ...readDeps }),
  });
  assert.equal(attempt.result.status, 'failed', 'A wallet rejection with no transaction hash is not confused with a confirmed invoice.');
  assert.equal(submitCount, 1);
  assert.equal(waitCount, 0);
}

{
  const runIfIdle = createPaymentSubmissionGate();
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let submitCount = 0;
  const first = runIfIdle(async () => {
    submitCount += 1;
    await blocked;
  });
  const duplicate = await runIfIdle(async () => { submitCount += 1; });
  assert.equal(duplicate.started, false, 'A rapid second click is ignored while invoice creation is in flight.');
  assert.equal(submitCount, 1, 'Only one createInvoice operation begins.');
  releaseFirst();
  await first;
}

console.log('Invoice-creation mock tests passed. No wallet signing or network transaction was sent.');
