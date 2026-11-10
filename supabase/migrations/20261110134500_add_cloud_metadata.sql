alter table public.merchant_invoices
  add column if not exists client_name text not null default '',
  add column if not exists client_email text not null default '';

create table if not exists public.payment_attempts (
  chain_id bigint not null default 5042002 check (chain_id = 5042002),
  contract_address text not null check (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  merchant_address text not null check (merchant_address ~ '^0x[0-9a-fA-F]{40}$'),
  invoice_id text not null check (invoice_id ~ '^0x[0-9a-fA-F]{64}$'),
  payer_privy_user_id text not null,
  payer_address text not null check (payer_address ~ '^0x[0-9a-fA-F]{40}$'),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  updated_at timestamp with time zone not null default now(),
  primary key (chain_id, contract_address, merchant_address, invoice_id, payer_privy_user_id)
);

alter table public.payment_attempts enable row level security;

comment on table public.payment_attempts is
  'Privy-user-scoped, unverified wallet submission hints only; contract state remains the sole source of payment status.';
comment on column public.payment_attempts.tx_hash is
  'Wallet-reported hash for an ambiguous submission; never proof of payment.';
comment on column public.merchant_invoices.client_name is
  'Off-chain invoice recipient name; not stored on the deployed invoice contract.';
comment on column public.merchant_invoices.client_email is
  'Off-chain invoice recipient email; not stored on the deployed invoice contract.';
