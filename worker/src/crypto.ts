import type { Env } from "./env";

// ---------------------------------------------------------------------------
// Secret encryption at rest (AES-GCM) + signed session tokens (HMAC-SHA256).
// One module so the Worker, connectors, and auth all share the same primitives.
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(b64);
}

// --------------------------------------------------------------------- AES-GCM secrets

async function importEncKey(env: Env): Promise<CryptoKey> {
  if (!env.SETTINGS_ENC_KEY) throw new Error("SETTINGS_ENC_KEY is not configured");
  return crypto.subtle.importKey("raw", base64ToBytes(env.SETTINGS_ENC_KEY), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<{ ct: string; iv: string }> {
  const key = await importEncKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ct: bytesToBase64(new Uint8Array(buf)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(env: Env, ctB64: string, ivB64: string): Promise<string> {
  const key = await importEncKey(env);
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivB64) }, key, base64ToBytes(ctB64));
  return new TextDecoder().decode(buf);
}

// --------------------------------------------------------------------- HMAC session tokens

// Falls back to CONTROL_PASSWORD so no extra config is required to ship sessions; set
// SESSION_SECRET to rotate sessions independently of the login password.
function sessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET || env.CONTROL_PASSWORD;
  if (!secret) throw new Error("no session secret configured");
  return secret;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// Token = base64url(JSON payload) + "." + base64url(HMAC). Stateless; the only state is the
// shared secret, so a single env change invalidates every outstanding session.
export async function signSession(env: Env, ttlMs: number): Promise<string> {
  const key = await importHmacKey(sessionSecret(env));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + ttlMs })));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(env: Env, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await importHmacKey(sessionSecret(env));
    const ok = await crypto.subtle.verify("HMAC", key, base64UrlDecode(sig), new TextEncoder().encode(payload));
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { exp?: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// Length-independent equality for comparing the login password.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
