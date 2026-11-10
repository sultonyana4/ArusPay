export const PRIVY_APP_ID = 'cmw96cg3m00c30hl5gg2jvnxa';
export const PRIVY_ISSUER = 'privy.io';
export const ARC_CHAIN_ID = 5042002;
export const ARUSPAY_CONTRACT_ADDRESS = '0x0cc3b91fc603ef15d80b3c0e8db222e5988b8926';
export const PRODUCTION_ORIGIN = 'https://aruspay-pi.vercel.app';
export const PRODUCTION_ORIGINS = new Set(['https://termul.xyz', 'https://termul-pay.vercel.app', PRODUCTION_ORIGIN]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const INVOICE_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.status = 400;
  }
}

export function isAllowedOrigin(origin) {
  return PRODUCTION_ORIGINS.has(origin);
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') throw new InputError(`Invalid ${field}.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new InputError(`Invalid ${field}.`);
  return text;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) throw new InputError(`Invalid ${field}.`);
  return value.trim();
}

function address(value, field) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new InputError(`Invalid ${field}.`);
  return value.toLowerCase();
}

function invoiceId(value) {
  if (typeof value !== 'string' || !INVOICE_ID_RE.test(value)) throw new InputError('Invalid invoice ID.');
  return value.toLowerCase();
}

function transactionHash(value, field, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new InputError(`Invalid ${field}.`);
  return value.toLowerCase();
}

export function parseProfilePayload(payload) {
  const displayName = requiredText(payload?.displayName, 'display name', 40);
  return { display_name: displayName };
}

export function parseInvoicePayload(payload, privyUserId) {
  const invoice = payload?.invoice;
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) throw new InputError('Invalid invoice metadata.');
  if (Number(invoice.chainId) !== ARC_CHAIN_ID) throw new InputError('Unsupported chain.');
  if (typeof invoice.contractAddress !== 'string'
    || invoice.contractAddress.toLowerCase() !== ARUSPAY_CONTRACT_ADDRESS) {
    throw new InputError('Unsupported invoice contract.');
  }

  const amount = invoice.amountNative;
  if (typeof amount !== 'string' || !/^\d{1,78}$/.test(amount) || BigInt(amount) <= 0n) {
    throw new InputError('Invalid invoice amount.');
  }
  const expiresAtSeconds = invoice.expiresAt === null || invoice.expiresAt === undefined
    ? 0n
    : BigInt(requiredText(String(invoice.expiresAt), 'invoice expiry', 16));
  if (expiresAtSeconds < 0n || expiresAtSeconds > 253402300799n) throw new InputError('Invalid invoice expiry.');

  const clientName = optionalText(invoice.clientName, 'client name', 120);
  const clientEmail = optionalText(invoice.clientEmail, 'client email', 254);
  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new InputError('Invalid client email.');
  const description = optionalText(invoice.description, 'description', 1000);

  return {
    chain_id: ARC_CHAIN_ID,
    contract_address: ARUSPAY_CONTRACT_ADDRESS,
    merchant_privy_user_id: privyUserId,
    merchant_address: address(invoice.merchantAddress, 'merchant address'),
    invoice_id: invoiceId(invoice.invoiceId),
    amount_native: amount,
    client_name: clientName,
    client_email: clientEmail,
    description,
    expires_at: expiresAtSeconds === 0n ? null : new Date(Number(expiresAtSeconds) * 1000).toISOString(),
    create_tx_hash: transactionHash(invoice.createTxHash, 'creation transaction hash'),
  };
}

export function parsePaymentAttemptPayload(payload, privyUserId) {
  if (!payload || typeof payload !== 'object') throw new InputError('Invalid payment attempt.');
  return {
    chain_id: ARC_CHAIN_ID,
    contract_address: ARUSPAY_CONTRACT_ADDRESS,
    merchant_address: address(payload.merchantAddress, 'merchant address'),
    invoice_id: invoiceId(payload.invoiceId),
    payer_privy_user_id: privyUserId,
    payer_address: address(payload.payerAddress, 'payer address'),
    tx_hash: transactionHash(payload.transactionHash, 'transaction hash', true),
    updated_at: new Date().toISOString(),
  };
}

export function parseMerchantAddress(payload) {
  return address(payload?.merchantAddress, 'merchant address');
}

export function identityTokenHasWallet(claims, privyUserId, merchantAddress) {
  if (!claims || claims.sub !== privyUserId) return false;
  let linkedAccounts = claims.linked_accounts ?? claims.linkedAccounts;
  if (typeof linkedAccounts === 'string') {
    try {
      linkedAccounts = JSON.parse(linkedAccounts);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(linkedAccounts)) return false;
  const target = merchantAddress.toLowerCase();
  return linkedAccounts.some((account) => account
    && ['wallet', 'smart_wallet', 'ethereum'].includes(account.type)
    && typeof account.address === 'string'
    && account.address.toLowerCase() === target);
}

export function parseInvoiceLookup(payload) {
  return {
    merchant_address: parseMerchantAddress(payload),
    invoice_id: invoiceId(payload?.invoiceId),
  };
}
