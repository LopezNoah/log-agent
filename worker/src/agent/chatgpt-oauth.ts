// ---------------------------------------------------------------------------
// ChatGPT-subscription OAuth (device flow) for the codex backend.
//
// This module is framework-free (plain fetch + base64url JWT parsing) so it can be unit-tested
// against a stubbed `fetch`. It implements the device-code flow opencode uses to authenticate a
// ChatGPT subscription against `https://chatgpt.com/backend-api/codex/responses`, plus token
// refresh and a `fetch`-compatible wrapper that injects the Authorization / ChatGPT-Account-Id
// headers and rewrites the request URL to the codex endpoint.
//
// Token persistence is delegated to caller-provided get/saveTokens callbacks (we store the bundle
// as an encrypted connector secret in D1 — see provider.ts / connectors.ts), so this file never
// touches the database directly.
// ---------------------------------------------------------------------------

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";
const DEVICE_VERIFICATION_URI = `${CHATGPT_ISSUER}/codex/device`;
const REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
const USER_AGENT = "opencode-phone/1.0 (+https://github.com/sst/opencode)";

// The persisted OAuth bundle (what we encrypt into the connector secret).
export interface ChatGptTokens {
  access: string;
  refresh: string;
  expires: number; // epoch ms
  accountId: string;
}

export interface DeviceAuthStart {
  device_auth_id: string;
  user_code: string;
  verification_uri: string;
  interval: number; // seconds between polls
}

export type DeviceAuthPoll =
  | { status: "pending" }
  | { status: "connected"; tokens: ChatGptTokens }
  | { status: "error"; error: string };

interface RawTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

// 1. Kick off the device flow: get a user_code the human types at the verification URI.
export async function startDeviceAuth(): Promise<DeviceAuthStart> {
  const res = await fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
  });
  if (!res.ok) {
    throw new Error(`deviceauth_usercode_failed:${res.status}:${await safeText(res)}`);
  }
  const data = (await res.json()) as { device_auth_id?: string; user_code?: string; interval?: number };
  if (!data.device_auth_id || !data.user_code) {
    throw new Error("deviceauth_usercode_malformed");
  }
  return {
    device_auth_id: data.device_auth_id,
    user_code: data.user_code,
    verification_uri: DEVICE_VERIFICATION_URI,
    interval: typeof data.interval === "number" && data.interval > 0 ? data.interval : 5,
  };
}

// 3. Poll once. The backend returns 403/404 while the user hasn't entered the code yet; a 200
// carries the authorization_code + code_verifier we then exchange for tokens.
export async function pollDeviceAuth(input: { device_auth_id: string; user_code: string }): Promise<DeviceAuthPoll> {
  const res = await fetch(`${CHATGPT_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ device_auth_id: input.device_auth_id, user_code: input.user_code }),
  });

  if (res.status === 403 || res.status === 404) return { status: "pending" };
  if (!res.ok) return { status: "error", error: `deviceauth_token:${res.status}:${await safeText(res)}` };

  const data = (await res.json()) as { authorization_code?: string; code_verifier?: string };
  if (!data.authorization_code || !data.code_verifier) {
    // Some backends return 200 with no code yet — treat as still pending rather than an error.
    return { status: "pending" };
  }

  try {
    const tokens = await exchangeDeviceCode(data.authorization_code, data.code_verifier);
    return { status: "connected", tokens };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// 4. Exchange the authorization_code (+ PKCE code_verifier) for the full token set.
export async function exchangeDeviceCode(authorization_code: string, code_verifier: string): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorization_code,
    redirect_uri: REDIRECT_URI,
    client_id: CHATGPT_CLIENT_ID,
    code_verifier,
  });
  const res = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`oauth_token_exchange_failed:${res.status}:${await safeText(res)}`);
  const data = (await res.json()) as RawTokenResponse;
  return toTokens(data, undefined);
}

// REFRESH: trade a refresh_token for a fresh access (and possibly rotated refresh) token. The
// refresh_token may rotate — callers MUST persist whatever this returns.
export async function refreshTokens(refresh: string): Promise<ChatGptTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: CHATGPT_CLIENT_ID,
  });
  const res = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`oauth_token_refresh_failed:${res.status}:${await safeText(res)}`);
  const data = (await res.json()) as RawTokenResponse;
  // refresh_token may be absent on a rotation-free refresh → keep the old one.
  return toTokens(data, refresh);
}

// Build a ChatGptTokens bundle from a raw OAuth response. `fallbackRefresh` keeps the previous
// refresh token when the server doesn't rotate it.
function toTokens(data: RawTokenResponse, fallbackRefresh: string | undefined): ChatGptTokens {
  const access = data.access_token || "";
  if (!access) throw new Error("oauth_token_no_access");
  const refresh = data.refresh_token || fallbackRefresh || "";
  const expires = Date.now() + (data.expires_in ?? 3600) * 1000;
  const accountId = extractAccountId({ id_token: data.id_token, access_token: access });
  return { access, refresh, expires, accountId };
}

// Pull the ChatGPT account id out of the id_token (preferred) or access_token JWT claims.
export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string {
  for (const jwt of [tokens.id_token, tokens.access_token]) {
    const claims = jwt ? decodeJwtClaims(jwt) : null;
    if (!claims) continue;
    const direct = claims["chatgpt_account_id"];
    if (typeof direct === "string" && direct) return direct;
    const auth = claims["https://api.openai.com/auth"];
    if (auth && typeof auth === "object") {
      const nested = (auth as Record<string, unknown>)["chatgpt_account_id"];
      if (typeof nested === "string" && nested) return nested;
    }
    const orgs = claims["organizations"];
    if (Array.isArray(orgs) && orgs.length && orgs[0] && typeof orgs[0] === "object") {
      const id = (orgs[0] as Record<string, unknown>)["id"];
      if (typeof id === "string" && id) return id;
    }
  }
  return "";
}

// Decode the (unverified) claims from a JWT's middle segment. base64url, no padding.
function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = base64UrlToString(parts[1]);
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function base64UrlToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Codex fetch wrapper
// ---------------------------------------------------------------------------

export interface CodexFetchOpts {
  // Read the currently-stored tokens (decrypt the connector bundle).
  getTokens: () => Promise<ChatGptTokens>;
  // Persist a refreshed bundle (re-encrypt + UPDATE the connector row).
  saveTokens: (tokens: ChatGptTokens) => Promise<void>;
  // Optional originator/User-Agent overrides; sensible defaults applied otherwise.
  originator?: string;
  userAgent?: string;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

// Returns a fetch-compatible function that:
//   - drops any incoming Authorization header,
//   - refreshes the access token (single-flight) when missing/expired and PERSISTS the result,
//   - sets `Authorization: Bearer <access>` + `ChatGPT-Account-Id` + originator/User-Agent,
//   - rewrites the URL to the codex endpoint when the path is /v1/responses or /chat/completions,
//   - strips maxOutputTokens / max_output_tokens from the JSON body (the codex backend rejects it).
export function createCodexFetch(opts: CodexFetchOpts): typeof fetch {
  const originator = opts.originator ?? "opencode";
  const userAgent = opts.userAgent ?? USER_AGENT;
  // Single-flight refresh: concurrent requests share one in-flight refresh promise.
  let refreshing: Promise<ChatGptTokens> | null = null;

  async function ensureFresh(): Promise<ChatGptTokens> {
    let tokens = await opts.getTokens();
    if (tokens.access && tokens.expires > Date.now()) return tokens;
    if (!refreshing) {
      refreshing = (async () => {
        const fresh = await refreshTokens(tokens.refresh);
        // Carry over the account id if the refresh response didn't surface one.
        if (!fresh.accountId) fresh.accountId = tokens.accountId;
        await opts.saveTokens(fresh);
        return fresh;
      })().finally(() => {
        refreshing = null;
      });
    }
    tokens = await refreshing;
    return tokens;
  }

  const wrapped = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const tokens = await ensureFresh();

    // Normalize to a Request so we can read/rewrite headers, url and body uniformly.
    const req = new Request(input as RequestInfo, init as RequestInit);
    const headers = new Headers(req.headers);

    // Drop any stale Authorization the SDK may have attached, then set ours.
    headers.delete("authorization");
    headers.set("Authorization", `Bearer ${tokens.access}`);
    if (tokens.accountId) headers.set("ChatGPT-Account-Id", tokens.accountId);
    headers.set("originator", originator);
    headers.set("User-Agent", userAgent);

    // Rewrite the endpoint: anything aimed at /v1/responses or /chat/completions goes to codex.
    const url = new URL(req.url);
    if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
      url.href = CHATGPT_CODEX_RESPONSES;
    }

    // Strip maxOutputTokens from the body (the picky codex backend 400s on it).
    let body: BodyInit | null | undefined = req.body;
    if (req.method && req.method.toUpperCase() !== "GET" && req.method.toUpperCase() !== "HEAD") {
      const raw = await req.clone().text();
      if (raw) {
        const stripped = stripMaxOutputTokens(raw);
        if (stripped !== null) {
          body = stripped;
          headers.set("Content-Type", "application/json");
        } else {
          body = raw;
        }
      }
    }

    return fetch(url.toString(), {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
  };

  return wrapped as unknown as typeof fetch;
}

// Remove maxOutputTokens / max_output_tokens from a JSON request body. Returns the re-serialized
// JSON string, or null if the body wasn't JSON / nothing changed (caller keeps the raw body).
function stripMaxOutputTokens(raw: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  let changed = false;
  for (const key of ["maxOutputTokens", "max_output_tokens"]) {
    if (key in rec) {
      delete rec[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(rec) : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
