import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://deno.land/x/jose@v5.9.6/index.ts";

const APP_ID = "cmw96cg3m00c30hl5gg2jvnxa";
const ISSUER = "privy.io";
const MAX_BODY_BYTES = 8 * 1024;
const PRODUCTION_ORIGIN = "https://aruspay-pi.vercel.app";
const jwks = createRemoteJWKSet(
  new URL(`https://auth.privy.io/api/v1/apps/${APP_ID}/jwks.json`),
);

function isAllowedOrigin(origin: string): boolean {
  if (origin === PRODUCTION_ORIGIN) return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port) {
      return true;
    }
    return url.protocol === "https:" && /^aruspay-[a-z0-9-]+\.vercel\.app$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function jsonResponse(body: Record<string, unknown>, status: number, origin?: string): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, origin?: string): Response {
  return jsonResponse({ error: "Request could not be processed." }, status, origin);
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
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "POST") return errorResponse(405, origin);

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return errorResponse(415, origin);
  }

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse(413, origin);
  }

  let payload: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, origin);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse(400, origin);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return errorResponse(400, origin);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return errorResponse(401, origin);

  let subject: string;
  try {
    const { payload: claims } = await jwtVerify(match[1], jwks, {
      issuer: ISSUER,
      audience: APP_ID,
      algorithms: ["ES256"],
    });
    if (typeof claims.sub !== "string" || !claims.sub.startsWith("did:privy:")) {
      return errorResponse(401, origin);
    }
    subject = claims.sub;
  } catch {
    return errorResponse(401, origin);
  }

  const action = payload.action;
  if (action !== "get_profile" && action !== "save_profile") {
    return errorResponse(400, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return errorResponse(500, origin);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "get_profile") {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name, primary_wallet_address, created_at, updated_at")
        .eq("privy_user_id", subject)
        .maybeSingle();
      if (error) return errorResponse(500, origin);
      return jsonResponse({ profile: data ?? null }, 200, origin);
    }

    if (typeof payload.displayName !== "string") return errorResponse(400, origin);
    const displayName = payload.displayName.trim();
    if (displayName.length < 1 || displayName.length > 40) {
      return errorResponse(400, origin);
    }

    const { data, error } = await supabase
      .from("profiles")
      .upsert(
        { privy_user_id: subject, display_name: displayName, updated_at: new Date().toISOString() },
        { onConflict: "privy_user_id" },
      )
      .select("display_name, primary_wallet_address, created_at, updated_at")
      .single();
    if (error) return errorResponse(500, origin);
    return jsonResponse({ profile: data }, 200, origin);
  } catch {
    return errorResponse(500, origin);
  }
});
