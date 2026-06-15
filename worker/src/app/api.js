import { state } from "./state.js";

// Any 401 means the session cookie expired — bounce to the login page.
export function ensureAuthed(res) {
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    throw new Error("unauthorized");
  }
  return res;
}

export async function api(path, opts = {}) {
  const res = ensureAuthed(await fetch("/opencode" + path, { credentials: "same-origin", ...opts }));
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export async function fsApi(path, opts = {}) {
  const res = ensureAuthed(await fetch(path, { credentials: "same-origin", ...opts }));
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
