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

  if (!response.ok) throw new Error(`Fly API ${response.status}: ${await response.text()}`);
  if (response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function flyMachineStatus(env: Env): Promise<Record<string, unknown>> {
  return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${env.FLY_MACHINE_ID}`);
}

export async function flyMachineAction(env: Env, action: "start" | "stop"): Promise<Record<string, unknown>> {
  return flyRequest(env, `/apps/${env.FLY_APP_NAME}/machines/${env.FLY_MACHINE_ID}/${action}`, { method: "POST" });
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
