import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseUnits,
} from 'viem';
import {
  getPaymentDisplayState,
  matchesPaymentTransaction,
  pollPaymentReconciliation,
  reconcilePaymentAttempt,
  submitPaymentOnce,
} from '../src/payment-result.js';

const chainId = 5042002;
const contract = '0x0cc3b91fc603ef15d80b3c0e8db222e5988b8926';
const merchant = '0x4d3e3dc6d280cdd8ba520f8e4b9ac3bf762bbdfe';
const payer = '0x1111111111111111111111111111111111111111';
const invoiceId = `0x${'ab'.repeat(32)}`;
const amount = parseUnits('0.10', 18);
const hash = `0x${'12'.repeat(32)}`;
const abi = [
  {
    type: 'function',
    name: 'payInvoice',
    stateMutability: 'payable',
    inputs: [{ name: 'merchant', type: 'address' }, { name: 'invoiceId', type: 'bytes32' }],
    outputs: [],
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
const expected = { chainId, contract, merchant, invoiceId, payer, amount, abi, status: { open: 1, paid: 2 } };
const calldata = encodeFunctionData({ abi, functionName: 'payInvoice', args: [merchant, invoiceId] });
const transaction = {
  hash,
  from: payer,
  to: contract,
  input: calldata,
  value: amount,
  chainId,
};
const eventTopics = encodeEventTopics({ abi, eventName: 'InvoicePaid', args: { invoiceId, merchant, payer } });
const eventData = encodeAbiParameters([{ type: 'uint256' }], [amount]);
const paidLog = {
  address: contract,
  transactionHash: hash,
  topics: eventTopics,
  data: eventData,
  args: { invoiceId, merchant, payer, amount },
};
const successfulReceipt = {
  transactionHash: hash,
  status: 'success',
  logs: [{ address: contract, topics: eventTopics, data: eventData }],
};
const revertedReceipt = { transactionHash: hash, status: 'reverted', logs: [] };
const onchainInvoice = (status) => ({ merchant, amount, expiresAt: 0n, status });
const commonDeps = {
  readChainId: async () => chainId,
  readInvoice: async () => onchainInvoice(2),
  readReceipt: async () => successfulReceipt,
  readTransaction: async () => transaction,
  findPaymentLogs: async () => [paidLog],
  findPendingTransactions: async () => [],
};

{
  const result = await reconcilePaymentAttempt({ expected, transactionHash: hash, ...commonDeps });
  assert.equal(result.status, 'paid', 'A successful receipt and Paid contract state are confirmed.');
  assert.equal(result.paymentTxHash, hash, 'The exact transaction hash is retained.');
  assert.equal(result.payer, payer, 'The payer is taken from the verified contract event.');
}

{
  let submitCount = 0;
  const result = await submitPaymentOnce({
    submit: async () => {
      submitCount += 1;
      throw new Error('nonce too low: next nonce 2, tx nonce 1 (already known)');
    },
    waitForReceipt: async () => { throw new Error('Must not wait without a hash.'); },
    reconcile: ({ transactionHash, error }) => reconcilePaymentAttempt({
      expected,
      transactionHash,
      error,
      ...commonDeps,
    }),
  });
  assert.equal(result.result.status, 'paid', 'A mined payment is found through its contract event after nonce/already-known errors.');
  assert.equal(result.result.paymentTxHash, hash, 'The mined payment hash comes from the matching event and receipt.');
  assert.equal(submitCount, 1, 'An ambiguous nonce/already-known error never causes an automatic resubmission.');
}

{
  let submitCount = 0;
  let invoiceReads = 0;
  let eventReads = 0;
  const delayedPaidDeps = {
    readChainId: async () => chainId,
    readInvoice: async () => onchainInvoice(++invoiceReads >= 5 ? 2 : 1),
    readReceipt: async () => successfulReceipt,
    readTransaction: async () => transaction,
    findPaymentLogs: async () => (++eventReads >= 1 ? [paidLog] : []),
    findPendingTransactions: async () => [],
  };
  const attempt = await submitPaymentOnce({
    submit: async () => {
      submitCount += 1;
      throw new Error('already known: nonce too low: next nonce 4, tx nonce 3');
    },
    waitForReceipt: async () => { throw new Error('Must not wait without a transaction hash.'); },
    reconcile: ({ transactionHash, error }) => reconcilePaymentAttempt({
      expected,
      transactionHash,
      error,
      ...delayedPaidDeps,
    }),
  });
  assert.equal(attempt.result.status, 'paid', 'A matching successful contract event proves Paid even when the first state read is stale.');
  assert.equal(attempt.result.contractStatePending, true, 'The stale contract-state read is tracked separately from the confirmed event.');
  assert.equal(attempt.result.ambiguous, true, 'already known and nonce-too-low errors remain ambiguous.');
  const finalResult = await pollPaymentReconciliation({
    initialResult: attempt.result,
    reconcile: () => reconcilePaymentAttempt({ expected, error: attempt.error, ...delayedPaidDeps }),
    intervalMs: 0,
    maxAttempts: 4,
    sleep: async () => {},
  });
  assert.equal(finalResult.status, 'paid', 'Bounded read-only polling catches the delayed on-chain Paid transition.');
  assert.equal(finalResult.contractStatePending, undefined, 'Polling continues until the contract state itself catches up.');
  assert.equal(finalResult.paymentTxHash, hash, 'The eventual confirmed event supplies the exact transaction hash.');
  assert.equal(submitCount, 1, 'Polling never resubmits the payment.');
}

{
  let submitCount = 0;
  let invoiceReads = 0;
  let receiptReads = 0;
  const mockWallet = {
    writeContract: async () => {
      submitCount += 1;
      throw Object.assign(new Error('already known: nonce too low: next nonce 5, tx nonce 4'), {
        cause: new Error('Missing or invalid parameters.'),
      });
    },
  };
  const delayedRpcDeps = {
    readChainId: async () => chainId,
    readInvoice: async () => onchainInvoice(++invoiceReads >= 5 ? 2 : 1),
    readReceipt: async () => {
      receiptReads += 1;
      if (receiptReads <= 2) throw new Error('Transaction receipt not available yet.');
      return successfulReceipt;
    },
    readTransaction: async () => transaction,
    findPaymentLogs: async () => [paidLog],
    findPendingTransactions: async () => [],
  };
  const attempt = await submitPaymentOnce({
    submit: () => mockWallet.writeContract({ functionName: 'payInvoice' }),
    waitForReceipt: async () => { throw new Error('No wallet hash was returned, so receipt waiting must not run.'); },
    reconcile: ({ transactionHash, receiptHint, error }) => reconcilePaymentAttempt({
      expected,
      transactionHash,
      receiptHint,
      error,
      ...delayedRpcDeps,
    }),
  });
  assert.equal(attempt.result.status, 'open', 'A known wallet error remains uncertain while the receipt is unavailable.');
  assert.equal(attempt.ambiguous, true, 'The nested Privy parameter error does not erase the ambiguous already-known result.');
  const finalResult = await pollPaymentReconciliation({
    initialResult: attempt.result,
    reconcile: () => reconcilePaymentAttempt({ expected, error: attempt.error, ...delayedRpcDeps }),
    intervalMs: 0,
    maxAttempts: 8,
    sleep: async () => {},
  });
  assert.equal(finalResult.status, 'paid', 'The matching event and delayed successful receipt confirm payment without a refresh.');
  assert.equal(finalResult.paymentTxHash, hash, 'The exact hash is recovered from the verified contract event.');
  assert.equal(finalResult.contractStatePending, undefined, 'The poll waits until the contract-state RPC also reports Paid.');
  assert.equal(invoiceReads, 5, 'Contract-state propagation is retried read-only.');
  assert.equal(receiptReads, 5, 'Receipt propagation is retried read-only.');
  assert.equal(submitCount, 1, 'The mock wallet is never resubmitted while reconciliation runs.');
}

{
  const paidFromEvent = getPaymentDisplayState({
    invoiceStatus: 1,
    paymentStatus: 'paid',
    hasPaymentAttempt: true,
    expiresAt: 0n,
  });
  assert.equal(paidFromEvent.label, 'Paid', 'A verified payment result overrides a stale Open RPC read in the visible invoice.');
  assert.equal(paidFromEvent.canPay, false, 'The Pay button is omitted once payment is confirmed.');
  const paidFromContract = getPaymentDisplayState({ invoiceStatus: 2, hasPaymentAttempt: false, expiresAt: 0n });
  assert.equal(paidFromContract.canPay, false, 'A Paid contract state never offers Pay.');
  const open = getPaymentDisplayState({ invoiceStatus: 1, hasPaymentAttempt: false, expiresAt: 0n });
  assert.equal(open.canPay, true, 'An Open invoice without an uncertain payment still offers Pay.');
}

{
  let readCount = 0;
  const recovered = await pollPaymentReconciliation({
    initialResult: { status: 'unavailable', ambiguous: true },
    reconcile: async () => {
      readCount += 1;
      if (readCount === 1) throw new Error('Temporary Arc RPC read failure.');
      return { status: 'paid', paymentTxHash: hash, ambiguous: true };
    },
    intervalMs: 0,
    maxAttempts: 3,
    sleep: async () => {},
  });
  assert.equal(recovered.status, 'paid', 'A temporary RPC failure is retried read-only until Paid is confirmed.');
  assert.equal(readCount, 2);
}

{
  let receiptSearches = 0;
  const receiptLinked = await pollPaymentReconciliation({
    initialResult: { status: 'paid', proofUnavailable: true, paymentTxHash: null },
    reconcile: async () => {
      receiptSearches += 1;
      return receiptSearches === 1
        ? { status: 'paid', proofUnavailable: true, paymentTxHash: null }
        : { status: 'paid', proofUnavailable: false, paymentTxHash: hash };
    },
    intervalMs: 0,
    maxAttempts: 3,
    sleep: async () => {},
  });
  assert.equal(receiptLinked.status, 'paid', 'Paid remains confirmed while receipt discovery continues.');
  assert.equal(receiptLinked.paymentTxHash, hash, 'A delayed explorer transaction link is attached without a page refresh.');
  assert.equal(receiptSearches, 2);
}

{
  let readCount = 0;
  const stillPending = await pollPaymentReconciliation({
    initialResult: { status: 'pending', paymentTxHash: hash, ambiguous: true },
    reconcile: async () => {
      readCount += 1;
      return { status: 'pending', paymentTxHash: hash, ambiguous: true };
    },
    intervalMs: 0,
    maxAttempts: 3,
    sleep: async () => {},
  });
  assert.equal(stillPending.status, 'pending', 'Unresolved transactions remain pending after the bounded polling window.');
  assert.equal(readCount, 3, 'Pending checks are bounded.');
}

{
  const result = await reconcilePaymentAttempt({
    expected,
    transactionHash: hash,
    readChainId: async () => chainId,
    readInvoice: async () => onchainInvoice(1),
    readReceipt: async () => revertedReceipt,
    readTransaction: async () => transaction,
    findPaymentLogs: async () => [],
    findPendingTransactions: async () => [],
  });
  assert.equal(result.status, 'reverted', 'A real reverted receipt is distinguished from an ambiguous wallet error.');
  assert.equal(result.invoice.status, 1, 'The contract remains the source of the Open status.');
}

{
  let submissionCount = 0;
  const result = await submitPaymentOnce({
    submit: async () => {
      submissionCount += 1;
      return hash;
    },
    waitForReceipt: async () => { throw new Error('Timed out waiting for transaction receipt.'); },
    reconcile: ({ transactionHash, error }) => reconcilePaymentAttempt({
      expected,
      transactionHash,
      error,
      readChainId: async () => chainId,
      readInvoice: async () => onchainInvoice(1),
      readReceipt: async () => { throw new Error('Receipt not found yet.'); },
      readTransaction: async () => transaction,
      findPaymentLogs: async () => [],
      findPendingTransactions: async () => [],
    }),
  });
  assert.equal(result.result.status, 'pending', 'A timeout with a matching known transaction is shown as pending, not failed.');
  assert.equal(result.result.paymentTxHash, hash);
  assert.equal(submissionCount, 1, 'A timeout never causes an automatic retry.');
}

{
  let scannedEvents = false;
  const result = await reconcilePaymentAttempt({
    expected,
    transactionHash: hash,
    error: new Error('Timed out waiting for receipt.'),
    readChainId: async () => chainId,
    readInvoice: async () => { throw new Error('Arc RPC unavailable.'); },
    readReceipt: async () => successfulReceipt,
    readTransaction: async () => transaction,
    findPaymentLogs: async () => { scannedEvents = true; return [paidLog]; },
    findPendingTransactions: async () => [],
  });
  assert.equal(result.status, 'unavailable', 'A failed contract read is not treated as Paid or Open.');
  assert.equal(result.reason, 'contract-read-failed');
  assert.equal(scannedEvents, false, 'Events/receipts cannot override an unavailable contract-state read.');
}

{
  const mismatchedTransaction = { ...transaction, from: '0x2222222222222222222222222222222222222222' };
  const result = await reconcilePaymentAttempt({
    expected,
    transactionHash: hash,
    readChainId: async () => chainId,
    readInvoice: async () => onchainInvoice(1),
    readReceipt: async () => successfulReceipt,
    readTransaction: async () => mismatchedTransaction,
    findPaymentLogs: async () => [],
    findPendingTransactions: async () => [],
  });
  assert.equal(result.status, 'open', 'A transaction from the wrong payer cannot be accepted as this payment.');
}

{
  const otherMerchant = '0x3333333333333333333333333333333333333333';
  const otherInvoiceId = `0x${'cd'.repeat(32)}`;
  const invalidTransactions = [
    { ...transaction, from: '0x2222222222222222222222222222222222222222' },
    { ...transaction, to: otherMerchant },
    { ...transaction, chainId: 1 },
    { ...transaction, value: amount + 1n },
    { ...transaction, input: encodeFunctionData({ abi, functionName: 'payInvoice', args: [otherMerchant, invoiceId] }) },
    { ...transaction, input: encodeFunctionData({ abi, functionName: 'payInvoice', args: [merchant, otherInvoiceId] }) },
  ];
  for (const invalidTransaction of invalidTransactions) {
    assert.equal(matchesPaymentTransaction(invalidTransaction, expected), false,
      'A payment proof must match expected payer, chain, contract, value, merchant, and invoice ID.');
  }
}

console.log('Payment-result regression tests passed (mocked reads only; no wallet, RPC, or transaction submission).');
