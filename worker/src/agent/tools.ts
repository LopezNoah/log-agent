import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { boxFetch, runCommand } from "./box";

// The agent's tools. The Worker (not the model) executes them against the Fly box, so secrets and
// orchestration stay Worker-side and the VM is just the hands. These are AI SDK `tool()` objects;
// the execute bodies are plain async fns, so swapping the agent framework later (Flue/custom) only
// means re-wrapping these — the tool logic is framework-agnostic.
export function createTools(env: Env) {
  return {
    fs_read: tool({
      description: "Read a UTF-8 file from the workspace. Returns its content.",
      inputSchema: z.object({ path: z.string().describe("workspace-relative file path") }),
      execute: async ({ path }) => {
        const r = await boxFetch(env, `/fs/file?path=${encodeURIComponent(path)}`);
        if (!r.ok) return { error: `read_failed_${r.status}` };
        const j = (await r.json()) as { content?: string };
        return { path, content: j.content ?? "" };
      },
    }),

    fs_write: tool({
      description: "Create or overwrite a file in the workspace with the given content.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const r = await boxFetch(env, "/fs/file", { method: "PUT", body: JSON.stringify({ path, content }) });
        return r.ok ? { ok: true, path } : { error: `write_failed_${r.status}` };
      },
    }),

    fs_list: tool({
      description: "List the workspace file tree (directories + files) to a given depth.",
      inputSchema: z.object({
        path: z.string().optional().describe("subdirectory to list; default workspace root"),
        depth: z.number().int().min(1).max(5).optional(),
      }),
      execute: async ({ path = "", depth = 2 }) => {
        const r = await boxFetch(env, `/fs/tree?path=${encodeURIComponent(path)}&depth=${depth}`);
        return r.ok ? await r.json() : { error: `list_failed_${r.status}` };
      },
    }),

    exec: tool({
      description:
        "Run a shell command in the workspace and wait for it to finish. Returns the combined output and exit code. Use for npm install, running tests, builds, git, etc. Output is truncated if very long; a returned runId can be passed to exec_kill if a command hangs.",
      inputSchema: z.object({
        command: z.string().describe("the shell command, e.g. 'npm test'"),
        cwd: z.string().optional().describe("workspace-relative working directory"),
        timeoutMs: z.number().int().positive().optional(),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        const r = await runCommand(env, { command, cwd, timeoutMs });
        return { runId: r.id, exitCode: r.exitCode, status: r.status, output: r.output, truncated: r.truncated };
      },
    }),

    exec_kill: tool({
      description: "Kill a still-running command (and its whole process tree) by the runId from a prior exec call.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        const r = await boxFetch(env, `/exec/${encodeURIComponent(runId)}/kill`, { method: "POST" });
        return r.ok ? { ok: true } : { error: `kill_failed_${r.status}` };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof createTools>;
