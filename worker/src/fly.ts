import type { Env } from "./env";

const MACHINE_API = "https://api.machines.dev/v1";

export function upstreamHeaders(env: Env): Headers {
  const headers = new Headers();
  if (env.FLY_UPSTREAM_AUTHORIZATION) headers.set("Authorization", env.FLY_UPSTREAM_AUTHORIZATION);
  return headers;
}

export async function flyRequest(env: Env, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!env.FLY_API_TOKEN) throw new Error("FLY_API_TOKEN is not configured");

  const response = await fetch(`${MACHINE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const err = new Error(`Fly API ${response.status}: ${await response.text()}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  if (response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// We resolve the machine by listing the app's machines rather than pinning a machine ID, so the
// Worker keeps working when the box is destroyed/recreated (e.g. a region change). The resolved
// id is cached per isolate and self-heals: a 404 (stale id) clears the cache and re-resolves.
// An explicit FLY_MACHINE_ID still wins, if ever set.
let cachedMachineId: string | null = null;

async function resolveMachineId(env: Env): Promise<string> {
  if (env.FLY_MACHINE_ID) return env.FLY_MACHINE_ID;
  if (cachedMachineId) return cachedMachineId;
  const data = await flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines`);
  const machines = (Array.isArray(data) ? data : []) as Array<Record<string, any>>;
  // Prefer the "app" process group; otherwise just take the first machine.
  const machine = machines.find((m) => m?.config?.process_group === "app") || machines[0];
  if (!machine?.id) throw new Error("no Fly machines found for app");
  cachedMachineId = String(machine.id);
  return cachedMachineId;
}

// Perform a per-machine request, re-resolving once if the cached id is stale (machine recreated).
async function machineRequest(env: Env, suffix: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const id = await resolveMachineId(env);
  try {
    return await flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${id}${suffix}`, init);
  } catch (e) {
    const stale = !env.FLY_MACHINE_ID && (e as { status?: number })?.status === 404;
    if (!stale) throw e;
    cachedMachineId = null;
    const fresh = await resolveMachineId(env);
    return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${fresh}${suffix}`, init);
  }
}

export async function flyMachineStatus(env: Env): Promise<Record<string, unknown>> {
  return machineRequest(env, "");
}

export async function flyMachineAction(env: Env, action: "start" | "stop"): Promise<Record<string, unknown>> {
  return machineRequest(env, `/${action}`, { method: "POST" });
}

export async function ensureFlyMachineStarted(env: Env): Promise<void> {
  const machine = await flyMachineStatus(env);
  const state = String(machine.state || "");
  if (state === "started" || state === "starting") return;
  await flyMachineAction(env, "start");
}

export async function ensureFlyMachineStopped(env: Env): Promise<void> {
  const machine = await flyMachineStatus(env);
  const state = String(machine.state || "");
  if (state === "stopped" || state === "suspended") return;
  await flyMachineAction(env, "stop");
}

// True only if the machine is already running. Callers use this to avoid waking the box
// (the Fly app has autostart=true, so any request to FLY_BASE_URL would start it).
export async function isMachineStarted(env: Env): Promise<boolean> {
  const machine = await flyMachineStatus(env).catch(() => null);
  return String(machine?.state || "") === "started";
}

// Best-effort GET against the Fly box (control server). Returns null on any failure. Only call
// when the machine is known to be started, or it will wake it.
export async function fetchUpstreamJson<T>(env: Env, path: string): Promise<T | null> {
  try {
    const res = await fetch(new URL(path, env.FLY_BASE_URL), { headers: upstreamHeaders(env) });
    if (!res.ok) return null;
    return await res.json<T>();
  } catch {
    return null;
  }
}
