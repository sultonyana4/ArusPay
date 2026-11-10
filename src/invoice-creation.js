import { decodeEventLog, decodeFunctionData, getAddress } from 'viem';
import {
  extractTransactionHash,
  isAmbiguousPaymentError,
  isDefinitelyNoSubmissionError,
} from './payment-result.js';

function sameHex(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

export function matchesInvoiceCreationTransaction(transaction, expected) {
  if (!transaction || !expected?.abi) return false;
  try {
    if (getAddress(transaction.from) !== getAddress(expected.merchant)) return false;
    if (getAddress(transaction.to) !== getAddress(expected.contract)) return false;
    if (transaction.chainId !== null && transaction.chainId !== undefined
      && Number(BigInt(transaction.chainId)) !== Number(expected.chainId)) return false;
    if (BigInt(transaction.value ?? 0n) !== 0n) return false;

    const input = transaction.input || transaction.data;
    if (typeof input !== 'string' || !input.startsWith('0x')) return false;
    const decoded = decodeFunctionData({ abi: expected.abi, data: input });
    return decoded.functionName === 'createInvoice'
      && sameHex(decoded.args[0], expected.invoiceId)
      && BigInt(decoded.args[1]) === BigInt(expected.amount)
      && BigInt(decoded.args[2]) === BigInt(expected.expiresAt);
  } catch {
    return false;
  }
}

function matchingInvoiceCreatedEvent(logs, expected, transactionHash) {
  if (!Array.isArray(logs)) return false;
  return logs.some((log) => {
    try {
      if (getAddress(log.address) !== getAddress(expected.contract)) return false;
      if (log.transactionHash && !sameHex(log.transactionHash, transactionHash)) return false;
      const decoded = decodeEventLog({
        abi: expected.abi,
        eventName: 'InvoiceCreated',
        data: log.data,
        topics: log.topics,
      });
      return sameHex(decoded.args.invoiceId, expected.invoiceId)
        && getAddress(decoded.args.merchant) === getAddress(expected.merchant)
        && BigInt(decoded.args.amount) === BigInt(expected.amount)
        && BigInt(decoded.args.expiresAt) === BigInt(expected.expiresAt);
    } catch {
      return false;
    }
  });
}

export async function reconcileInvoiceCreationAttempt({
  expected,
  transactionHash = null,
  receiptHint = null,
  error = null,
  readChainId,
  readReceipt,
  readTransaction,
}) {
  const ambiguous = Boolean(transactionHash || isAmbiguousPaymentError(error));
  let chainId;
  try {
    chainId = await readChainId();
  } catch {
    return {
      status: transactionHash ? 'pending' : ambiguous ? 'pending' : 'failed',
      transactionHash,
      ambiguous,
      reason: 'chain-read-unavailable',
    };
  }
  if (Number(chainId) !== Number(expected.chainId)) {
    return { status: 'unavailable', transactionHash, ambiguous: true, reason: 'wrong-chain' };
  }
  if (!transactionHash) {
    return { status: ambiguous ? 'pending' : 'failed', transactionHash: null, ambiguous };
  }

  let receipt = receiptHint;
  if (receipt && receipt.transactionHash && !sameHex(receipt.transactionHash, transactionHash)) receipt = null;
  if (!receipt) {
    try { receipt = await readReceipt(transactionHash); } catch { receipt = null; }
  }
  if (receipt?.transactionHash && !sameHex(receipt.transactionHash, transactionHash)) {
    return { status: 'unmatched', transactionHash, ambiguous: true, reason: 'receipt-hash-mismatch' };
  }

  let transaction = null;
  try { transaction = await readTransaction(transactionHash); } catch { transaction = null; }
  if (transaction?.hash && !sameHex(transaction.hash, transactionHash)) {
    return { status: 'unmatched', transactionHash, ambiguous: true, reason: 'transaction-hash-mismatch' };
  }
  if (!transaction) return { status: 'pending', transactionHash, ambiguous: true };
  if (!matchesInvoiceCreationTransaction(transaction, expected)) {
    if (receipt?.status === 'success') {
      return { status: 'unmatched', transactionHash, ambiguous: true, reason: 'transaction-mismatch' };
    }
    return { status: 'pending', transactionHash, ambiguous: true };
  }

  if (receipt?.status === 'reverted') {
    return { status: 'reverted', transactionHash, ambiguous: false };
  }
  if (receipt?.status === 'success') {
    return matchingInvoiceCreatedEvent(receipt.logs, expected, transactionHash)
      ? { status: 'created', transactionHash, ambiguous: false, receipt }
      : { status: 'unmatched', transactionHash, ambiguous: true, reason: 'invoice-created-event-mismatch' };
  }
  return { status: 'pending', transactionHash, ambiguous: true };
}

export async function submitInvoiceCreationOnce({ submit, waitForReceipt, reconcile }) {
  let transactionHash = null;
  let receipt = null;
  let error = null;
  let stage = 'submit';
  try {
    transactionHash = await submit();
  } catch (caught) {
    error = caught;
    transactionHash = extractTransactionHash(caught);
  }

  if (transactionHash) {
    stage = 'receipt';
    try {
      receipt = await waitForReceipt(transactionHash);
    } catch (caught) {
      // Preserve the broadcast error, including its locally computed hash, for reconciliation.
      if (!error) error = caught;
    }
  }

  const ambiguous = Boolean(transactionHash || (error && (
    isAmbiguousPaymentError(error)
    || (stage === 'submit' && !isDefinitelyNoSubmissionError(error))
  )));
  const reconciliationError = ambiguous && error && !isAmbiguousPaymentError(error)
    ? Object.assign(new Error('Invoice creation outcome is ambiguous.'), { cause: error })
    : error;
  const result = await reconcile({ transactionHash, receiptHint: receipt, error: reconciliationError });
  return { transactionHash, receipt, error, stage, ambiguous, result };
}

export async function pollInvoiceCreationReconciliation({
  initialResult,
  reconcile,
  intervalMs = (attempt) => attempt < 5 ? 2000 : Math.min(30000, 2000 * (2 ** Math.floor((attempt - 5) / 4))),
  maxAttempts = Number.POSITIVE_INFINITY,
  shouldContinue = () => true,
  onUpdate = () => {},
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  let result = initialResult;
  const isSettled = (value) => ['created', 'reverted', 'failed', 'unmatched'].includes(value?.status);

  for (let attempt = 0; attempt < maxAttempts && !isSettled(result); attempt += 1) {
    if (!shouldContinue()) break;
    const delay = typeof intervalMs === 'function' ? intervalMs(attempt, result) : intervalMs;
    await sleep(delay);
    if (!shouldContinue()) break;
    try {
      result = await reconcile();
    } catch (error) {
      result = { status: 'pending', ambiguous: true, error };
    }
    await onUpdate(result);
  }
  return result;
}
