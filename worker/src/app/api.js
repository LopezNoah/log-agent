import { state } from "./state.js";

// Any 401 means the session cookie expired — bounce to the login page.
export function ensureAuthed(res) {
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    throw new Error("unauthorized");
  }
  return res;
}

// Default cap on how long we'll wait for the box. Quick ops (session CRUD, fs, agents) finish in
// well under a second on a healthy box; the cap just turns a wedged/524ing box into a fast, clear
// failure instead of a ~100s hang. Pass { timeout: 0 } to opt out for legitimately long LLM ops
// (sending a prompt, compacting).
const DEFAULT_TIMEOUT_MS = 25_000;

async function fetchWithTimeout(url, opts, timeout) {
  if (!timeout) return fetch(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("timed out — the machine may be busy or down");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function api(path, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, ...init } = opts;
  const res = ensureAuthed(await fetchWithTimeout("/opencode" + path, { credentials: "same-origin", ...init }, timeout));
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export async function fsApi(path, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, ...init } = opts;
  const res = ensureAuthed(await fetchWithTimeout(path, { credentials: "same-origin", ...init }, timeout));
  if (!res.ok) {
    let message = `${opts.method || "GET"} ${path} → ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message += ` (${body.error})`;
    } catch {
      /* ignore non-JSON errors */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

export async function getMachine() {
  try {
    const res = ensureAuthed(await fetch("/api/machine", { credentials: "same-origin" }));
    if (!res.ok) return "unknown";
    const { machine } = await res.json();
    return String(machine?.state || "unknown");
  } catch {
    return "unknown";
  }
}

// The default LLM connector's model is what we attach to each outgoing message.
export async function loadDefaultModel() {
  try {
    const res = ensureAuthed(await fetch("/api/connectors", { credentials: "same-origin" }));
    if (!res.ok) return;
    const { connectors } = await res.json();
    const def = (connectors || []).find((c) => c.type === "llm" && c.isDefault);
    state.model = def?.config?.model || null;
  } catch {
    /* leave state.model as-is */
  }
}
