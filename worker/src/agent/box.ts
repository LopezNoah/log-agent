import type { Env } from "../env";
import { upstreamHeaders } from "../fly";

// Authenticated fetch to the Fly box (control-server). Used by the agent's fs/exec tools so the
// Worker — not the model — talks to the VM. The box never sees LLM/provider secrets.
export function boxFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = upstreamHeaders(env);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!headers.has("Accept")) headers.set("Accept", init.headers && (init.headers as Record<string, string>).Accept ? (init.headers as Record<string, string>).Accept : "application/json");
  return fetch(new URL(path, env.FLY_BASE_URL), { ...init, headers });
}

export interface RunResult {
  id: string;
  exitCode: number | null;
  status: string; // running | exited | killed | error | timeout
  output: string; // combined stdout+stderr, truncated
  truncated: boolean;
}

const MAX_OUTPUT = 60_000;

// Start a command via the box /exec service, consume its SSE stream, and return the combined
// output + exit code once it finishes (bounded by timeout + output size). The model gets the
// result; the run id lets it kill a hung process via the exec_kill tool.
export async function runCommand(
  env: Env,
  opts: { command: string; cwd?: string; timeoutMs?: number },
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, 600_000) : 120_000;
  const start = await boxFetch(env, "/exec/start", {
    method: "POST",
    body: JSON.stringify({ command: opts.command, cwd: opts.cwd || "", timeoutMs }),
  });
  if (!start.ok) throw new Error(`exec_start_failed_${start.status}`);
  const { id } = (await start.json()) as { id: string };

  const ev = await boxFetch(env, `/exec/${encodeURIComponent(id)}/events`, { headers: { Accept: "text/event-stream" } });
  if (!ev.ok || !ev.body) return { id, exitCode: null, status: "error", output: "", truncated: false };

  const reader = ev.body.pipeThrough(new TextDecoderStream()).getReader();
  const deadline = Date.now() + timeoutMs + 15_000;
  let out = "";
  let truncated = false;
  let exitCode: number | null = null;
  let status = "running";
  let buf = "";
  const append = (text: string) => {
    if (out.length >= MAX_OUTPUT) { truncated = true; return; }
    out += text.length > MAX_OUTPUT - out.length ? (truncated = true, text.slice(0, MAX_OUTPUT - out.length)) : text;
  };

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "stdout" || event === "stderr") {
          try { append(JSON.parse(data).text || ""); } catch { /* skip */ }
        } else if (event === "exit") {
          try { const e = JSON.parse(data); exitCode = e.exitCode ?? null; status = e.status || "exited"; } catch { /* skip */ }
          return { id, exitCode, status, output: out, truncated };
        }
      }
    }
    status = "timeout";
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return { id, exitCode, status, output: out, truncated };
}
