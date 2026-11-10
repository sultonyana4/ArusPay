import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://deno.land/x/jose@v5.9.6/index.ts";
import {
  ARC_CHAIN_ID,
  ARUSPAY_CONTRACT_ADDRESS,
  InputError,
  PRIVY_APP_ID,
  PRIVY_ISSUER,
  identityTokenHasWallet,
  isAllowedOrigin,
  parseInvoiceLookup,
  parseInvoicePayload,
  parsePaymentAttemptPayload,
  parseMerchantAddress,
  parseProfilePayload,
} from "./domain.js";

const MAX_BODY_BYTES = 16 * 1024;
const jwks = createRemoteJWKSet(
  new URL(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/jwks.json`),
);
const INVOICE_METADATA_COLUMNS = "chain_id, contract_address, merchant_address, invoice_id, amount_native, client_name, client_email, description, expires_at, create_tx_hash, created_at";
const PAYMENT_ATTEMPT_COLUMNS = "payer_address, tx_hash, updated_at";

function jsonResponse(body: Record<string, unknown>, status: number, origin?: string): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Privy-Identity-Token");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, origin?: string): Response {
  return jsonResponse({ error: "Request could not be processed." }, status, origin);
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) throw new Error("Supabase service configuration is missing.");
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return null;
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function authenticate(request: Request): Promise<string | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match) return null;
  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: PRIVY_ISSUER,
      audience: PRIVY_APP_ID,
      algorithms: ["ES256"],
    });
    if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

async function verifyInvoiceWalletIdentity(request: Request, privyUserId: string, merchantAddress: string): Promise<boolean> {
  const token = request.headers.get("X-Privy-Identity-Token");
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: PRIVY_ISSUER,
      audience: PRIVY_APP_ID,
      algorithms: ["ES256"],
    });
    return identityTokenHasWallet(payload, privyUserId, merchantAddress);
  } catch {
    return false;
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin") ?? undefined;
  if (origin && !isAllowedOrigin(origin)) return errorResponse(403);

  if (request.method === "OPTIONS") {
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Privy-Identity-Token",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "POST") return errorResponse(405, origin);

  const authorizationSubject = await authenticate(request);
  if (!authorizationSubject) return errorResponse(401, origin);

  let payload: Record<string, unknown> | null;
  try {
    payload = await parseBody(request);
  } catch {
    return errorResponse(400, origin);
  }
  if (!payload) return errorResponse(415, origin);
  // This value is only a race guard; the signed token remains the identity authority.
  if (payload.expectedPrivyUserId !== authorizationSubject) return errorResponse(403, origin);

  const action = payload.action;
  const supportedActions = [
    "get_profile", "save_profile", "get_invoices", "save_invoice",
    "get_payment_attempt", "save_payment_attempt", "clear_payment_attempt",
  ];
  if (typeof action !== "string" || !supportedActions.includes(action)) return errorResponse(400, origin);

  try {
    const supabase = getSupabase();

    if (action === "get_profile") {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name, primary_wallet_address, created_at, updated_at")
        .eq("privy_user_id", authorizationSubject)
        .maybeSingle();
      if (error) return errorResponse(500, origin);
      return jsonResponse({ profile: data ?? null }, 200, origin);
    }

    if (action === "save_profile") {
      let profile: { display_name: string };
      try {
        profile = parseProfilePayload(payload);
      } catch (error) {
        return errorResponse(error instanceof InputError ? error.status : 400, origin);
      }
      const { data, error } = await supabase
        .from("profiles")
        .upsert(
          { privy_user_id: authorizationSubject, ...profile, updated_at: new Date().toISOString() },
          { onConflict: "privy_user_id" },
        )
        .select("display_name, primary_wallet_address, created_at, updated_at")
        .single();
      if (error) return errorResponse(500, origin);
      return jsonResponse({ profile: data }, 200, origin);
    }

    if (action === "get_invoices") {
      let merchantAddress: string;
      try {
        merchantAddress = parseMerchantAddress(payload);
      } catch (error) {
        return errorResponse(error instanceof InputError ? error.status : 400, origin);
      }
      if (!await verifyInvoiceWalletIdentity(request, authorizationSubject, merchantAddress)) {
        return errorResponse(403, origin);
      }
      const { data, error } = await supabase
        .from("merchant_invoices")
        .select(INVOICE_METADATA_COLUMNS)
        .eq("merchant_privy_user_id", authorizationSubject)
        .eq("chain_id", ARC_CHAIN_ID)
        .eq("contract_address", ARUSPAY_CONTRACT_ADDRESS)
        .eq("merchant_address", merchantAddress)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) return errorResponse(500, origin);
      return jsonResponse({ invoices: data ?? [] }, 200, origin);
    }

    if (action === "save_invoice") {
      let invoice: ReturnType<typeof parseInvoicePayload>;
      try {
        invoice = parseInvoicePayload(payload, authorizationSubject);
      } catch (error) {
        return errorResponse(error instanceof InputError ? error.status : 400, origin);
      }
      if (!await verifyInvoiceWalletIdentity(request, authorizationSubject, invoice.merchant_address)) {
        return errorResponse(403, origin);
      }
      const { data, error } = await supabase
        .from("merchant_invoices")
        .upsert(invoice, {
          onConflict: "chain_id,contract_address,merchant_address,invoice_id",
          ignoreDuplicates: true,
        })
        .select(INVOICE_METADATA_COLUMNS)
        .maybeSingle();
      if (error) return errorResponse(error.code === "23505" ? 409 : 500, origin);
      if (data) return jsonResponse({ invoice: data }, 200, origin);

      const { data: existing, error: lookupError } = await supabase
        .from("merchant_invoices")
        .select(INVOICE_METADATA_COLUMNS)
        .eq("merchant_privy_user_id", authorizationSubject)
        .eq("chain_id", ARC_CHAIN_ID)
        .eq("contract_address", ARUSPAY_CONTRACT_ADDRESS)
        .eq("merchant_address", invoice.merchant_address)
        .eq("invoice_id", invoice.invoice_id)
        .maybeSingle();
      if (lookupError) return errorResponse(500, origin);
      if (!existing) return errorResponse(409, origin);
      return jsonResponse({ invoice: existing }, 200, origin);
    }

    if (action === "get_payment_attempt") {
      let key: ReturnType<typeof parseInvoiceLookup>;
      try {
        key = parseInvoiceLookup(payload);
      } catch (error) {
        return errorResponse(error instanceof InputError ? error.status : 400, origin);
      }
      const { data, error } = await supabase
        .from("payment_attempts")
        .select(PAYMENT_ATTEMPT_COLUMNS)
        .eq("chain_id", ARC_CHAIN_ID)
        .eq("contract_address", ARUSPAY_CONTRACT_ADDRESS)
        .eq("merchant_address", key.merchant_address)
        .eq("invoice_id", key.invoice_id)
        .eq("payer_privy_user_id", authorizationSubject)
        .maybeSingle();
      if (error) return errorResponse(500, origin);
      return jsonResponse({ attempt: data ?? null }, 200, origin);
    }

    if (action === "save_payment_attempt") {
      let attempt: ReturnType<typeof parsePaymentAttemptPayload>;
      try {
        attempt = parsePaymentAttemptPayload(payload, authorizationSubject);
      } catch (error) {
        return errorResponse(error instanceof InputError ? error.status : 400, origin);
      }
      const { data, error } = await supabase
        .from("payment_attempts")
        .upsert(attempt, {
          onConflict: "chain_id,contract_address,merchant_address,invoice_id,payer_privy_user_id",
        })
        .select(PAYMENT_ATTEMPT_COLUMNS)
        .single();
      if (error) return errorResponse(500, origin);
      return jsonResponse({ attempt: data }, 200, origin);
    }

    if (action === "clear_payment_attempt") {
      let key: ReturnType<typeof parseInvoiceLookup>;
      try {
        key = parseInvoiceLookup(payload);
      } catch (error) {
        return errorResponse(error instanceof InputError ? error.status : 400, origin);
      }
      const { error } = await supabase
        .from("payment_attempts")
        .delete()
        .eq("chain_id", ARC_CHAIN_ID)
        .eq("contract_address", ARUSPAY_CONTRACT_ADDRESS)
        .eq("merchant_address", key.merchant_address)
        .eq("invoice_id", key.invoice_id)
        .eq("payer_privy_user_id", authorizationSubject);
      if (error) return errorResponse(500, origin);
      return jsonResponse({ cleared: true }, 200, origin);
    }

    return errorResponse(400, origin);
  } catch {
    return errorResponse(500, origin);
  }
});
