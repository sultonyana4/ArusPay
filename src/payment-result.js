import { decodeEventLog, decodeFunctionData, getAddress } from 'viem';

const TX_HASH_PATTERN = /\b0x[0-9a-fA-F]{64}\b/;

function errorText(error) {
  const values = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of ['shortMessage', 'message', 'details', 'reason', 'code', 'cause', 'data', 'metaMessages']) {
      visit(value[key], depth + 1);
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
  };
  visit(error);
  return values.join(' ');
}

export function extractTransactionHash(error) {
  const direct = [error?.transactionHash, error?.hash, error?.data?.transactionHash, error?.data?.hash]
    .find((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
  return direct || errorText(error).match(TX_HASH_PATTERN)?.[0] || null;
}

export function isAmbiguousPaymentError(error) {
  return /(already known|known transaction|nonce too low|replacement transaction underpriced|timed?\s*out|timeout|deadline exceeded|connection reset|socket|network error|fetch failed|request failed|gateway|temporarily unavailable|disconnected|unknown transaction|ambiguous)/i
    .test(errorText(error));
}

export function isDefinitelyNoSubmissionError(error) {
  return error?.code === 4001 || /(user rejected|user denied|rejected the request|cancelled by user|canceled by user|insufficient funds|execution reverted|invalid params|unsupported method)/i
    .test(errorText(error));
}

export function matchesPaymentTransaction(transaction, expected, payer = expected.payer) {
  if (!transaction || !expected?.abi) return false;
  try {
    if (getAddress(transaction.from) !== getAddress(payer)) return false;
    if (getAddress(transaction.to) !== getAddress(expected.contract)) return false;
    if (transaction.chainId !== null && transaction.chainId !== undefined
      && Number(BigInt(transaction.chainId)) !== Number(expected.chainId)) return false;
    if (BigInt(transaction.value ?? 0n) !== BigInt(expected.amount)) return false;
    const input = transaction.input || transaction.data;
    if (typeof input !== 'string' || !input.startsWith('0x')) return false;
    const decoded = decodeFunctionData({ abi: expected.abi, data: input });
    return decoded.functionName === 'payInvoice'
      && getAddress(decoded.args[0]) === getAddress(expected.merchant)
      && decoded.args[1].toLowerCase() === expected.invoiceId.toLowerCase();
  } catch {
    return false;
  }
}

function matchingPaymentEvent(logs, expected, payer) {
  if (!Array.isArray(logs)) return null;
  for (const log of logs) {
    try {
      if (getAddress(log.address) !== getAddress(expected.contract)) continue;
      const decoded = decodeEventLog({ abi: expected.abi, eventName: 'InvoicePaid', data: log.data, topics: log.topics });
      const args = decoded.args;
      if (args.invoiceId.toLowerCase() !== expected.invoiceId.toLowerCase()
        || getAddress(args.merchant) !== getAddress(expected.merchant)
        || getAddress(args.payer) !== getAddress(payer)
        || BigInt(args.amount) !== BigInt(expected.amount)) continue;
      return args;
    } catch {
      // Ignore unrelated logs, but never accept a partially decoded event.
    }
  }
  return null;
}

function matchingEventLog(logs, expected, args) {
  if (!Array.isArray(logs)) return false;
  return logs.some((log) => {
    try {
      if (getAddress(log.address) !== getAddress(expected.contract)) return false;
      const decoded = decodeEventLog({ abi: expected.abi, eventName: 'InvoicePaid', data: log.data, topics: log.topics });
      return decoded.args.invoiceId.toLowerCase() === expected.invoiceId.toLowerCase()
        && getAddress(decoded.args.merchant) === getAddress(expected.merchant)
        && getAddress(decoded.args.payer) === getAddress(args.payer)
        && BigInt(decoded.args.amount) === BigInt(expected.amount);
    } catch {
      return false;
    }
  });
}

function invoiceHasExpectedIdentity(invoice, expected) {
  return invoice && getAddress(invoice.merchant) === getAddress(expected.merchant)
    && BigInt(invoice.amount) === BigInt(expected.amount);
}

async function proveEventPayment(log, expected, deps, receiptHint = null) {
  const args = log?.args;
  if (!args || !log.transactionHash
    || args.invoiceId?.toLowerCase() !== expected.invoiceId.toLowerCase()
    || getAddress(args.merchant) !== getAddress(expected.merchant)
    || BigInt(args.amount) !== BigInt(expected.amount)) return null;

  let receipt = receiptHint?.transactionHash?.toLowerCase() === log.transactionHash.toLowerCase()
    ? receiptHint
    : null;
  if (!receipt) {
    try { receipt = await deps.readReceipt(log.transactionHash); } catch { return null; }
  }
  if (receipt?.status !== 'success' || !matchingEventLog(receipt.logs, expected, args)) return null;

  let transaction;
  try { transaction = await deps.readTransaction(log.transactionHash); } catch { return null; }
  if (!matchesPaymentTransaction(transaction, expected, args.payer)) return null;
  if (transaction.hash && transaction.hash.toLowerCase() !== log.transactionHash.toLowerCase()) return null;

  return {
    status: 'paid',
    invoice: null,
    paymentTxHash: log.transactionHash,
    payer: getAddress(args.payer),
    payerMatchesExpected: expected.payer ? getAddress(args.payer) === getAddress(expected.payer) : null,
    receiptStatus: 'success',
    proofUnavailable: false,
  };
}

async function findConfirmedPayment(expected, deps) {
  let logs;
  try { logs = await deps.findPaymentLogs(); } catch { return null; }
  for (const log of logs || []) {
    const proof = await proveEventPayment(log, expected, deps);
    if (proof) return proof;
  }
  return null;
}

export async function reconcilePaymentAttempt({
  expected,
  transactionHash = null,
  receiptHint = null,
  error = null,
  readChainId,
  readInvoice,
  readReceipt,
  readTransaction,
  findPaymentLogs,
  findPendingTransactions,
}) {
  const deps = { readReceipt, readTransaction, findPaymentLogs };
  let invoice;
  try {
    const chainId = await readChainId();
    if (Number(chainId) !== Number(expected.chainId)) {
      return { status: 'unavailable', invoice: null, paymentTxHash: null, reason: 'wrong-chain', ambiguous: isAmbiguousPaymentError(error) };
    }
    invoice = await readInvoice();
    if (!invoiceHasExpectedIdentity(invoice, expected)) {
      return { status: 'unavailable', invoice: null, paymentTxHash: null, reason: 'invoice-mismatch', ambiguous: isAmbiguousPaymentError(error) };
    }
  } catch {
    return { status: 'unavailable', invoice: null, paymentTxHash: null, reason: 'contract-read-failed', ambiguous: isAmbiguousPaymentError(error) };
  }

  const paidStatus = Number(expected.status?.paid ?? 2);
  const openStatus = Number(expected.status?.open ?? 1);
  const ambiguous = isAmbiguousPaymentError(error);

  if (Number(invoice.status) === paidStatus) {
    const proof = await findConfirmedPayment(expected, deps);
    return proof
      ? { ...proof, invoice, ambiguous }
      : { status: 'paid', invoice, paymentTxHash: null, payer: null, payerMatchesExpected: false, proofUnavailable: true, ambiguous };
  }

  if (Number(invoice.status) !== openStatus) {
    return { status: 'not-open', invoice, paymentTxHash: null, payer: null, proofUnavailable: false, ambiguous };
  }

  let receipt = receiptHint;
  if (transactionHash && (!receipt || receipt.transactionHash?.toLowerCase() !== transactionHash.toLowerCase())) {
    try { receipt = await readReceipt(transactionHash); } catch { receipt = null; }
  }

  if (transactionHash && receipt) {
    let transaction;
    try { transaction = await readTransaction(transactionHash); } catch { transaction = null; }
    const validTransaction = matchesPaymentTransaction(transaction, expected);
    if (validTransaction && receipt.status === 'reverted') {
      return { status: 'reverted', invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: false };
    }
    if (validTransaction && receipt.status === 'success'
      && matchingPaymentEvent(receipt.logs, expected, expected.payer)) {
      let refreshed;
      try { refreshed = await readInvoice(); } catch {
        return { status: 'unavailable', invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), reason: 'post-receipt-contract-read-failed', ambiguous: true };
      }
      if (!invoiceHasExpectedIdentity(refreshed, expected)) {
        return { status: 'unavailable', invoice: refreshed, paymentTxHash: null, reason: 'invoice-mismatch', ambiguous: true };
      }
      if (Number(refreshed.status) === paidStatus) {
        return { status: 'paid', invoice: refreshed, paymentTxHash: transactionHash, payer: getAddress(expected.payer), payerMatchesExpected: true, receiptStatus: 'success', proofUnavailable: false, ambiguous };
      }
      return { status: 'inconsistent', invoice: refreshed, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
    }
    if (validTransaction && receipt.status === 'success') {
      return { status: 'unmatched', invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
    }
  }

  if (transactionHash) {
    let transaction;
    try { transaction = await readTransaction(transactionHash); } catch { transaction = null; }
    if (matchesPaymentTransaction(transaction, expected)) {
      return { status: 'pending', invoice, paymentTxHash: transactionHash, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
    }
  }

  if (typeof findPendingTransactions === 'function') {
    try {
      const pending = await findPendingTransactions();
      const matches = (pending || []).filter((transaction) => matchesPaymentTransaction(transaction, expected));
      if (matches.length === 1) {
        return { status: 'pending', invoice, paymentTxHash: matches[0].hash || null, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
      }
      if (matches.length > 1) {
        return { status: 'inconsistent', invoice, paymentTxHash: null, payer: getAddress(expected.payer), proofUnavailable: false, ambiguous: true };
      }
    } catch {
      // Pending-block reads are best effort. An ambiguous wallet result remains guarded by the app.
    }
  }

  return { status: 'open', invoice, paymentTxHash: transactionHash, payer: null, proofUnavailable: false, ambiguous };
}

export async function submitPaymentOnce({ submit, waitForReceipt, reconcile }) {
  let transactionHash = null;
  let receipt = null;
  let error = null;
  let stage = 'submit';
  try {
    transactionHash = await submit();
  } catch (caught) {
    error = caught;
  }
  if (transactionHash) {
    stage = 'receipt';
    try {
      receipt = await waitForReceipt(transactionHash);
    } catch (caught) {
      error = caught;
    }
  }
  const extractedHash = transactionHash || extractTransactionHash(error);
  const ambiguous = Boolean(error && (isAmbiguousPaymentError(error)
    || (stage === 'submit' && !isDefinitelyNoSubmissionError(error))));
  const reconciliationError = ambiguous && !isAmbiguousPaymentError(error)
    ? Object.assign(new Error('Payment submission outcome is ambiguous.'), { cause: error })
    : error;
  const result = await reconcile({ transactionHash: extractedHash, receiptHint: receipt, error: reconciliationError });
  return { transactionHash: extractedHash, receipt, error, stage, ambiguous, result };
}
