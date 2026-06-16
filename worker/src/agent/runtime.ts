import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import type { Env } from "../env";
import { resolveModel } from "./provider";
import { createTools } from "./tools";

const DEFAULT_SYSTEM = `You are an autonomous coding agent operating on a remote workspace (a Fly.io VM).
You can read and write files and run shell commands there via your tools.
Work step by step: inspect with fs_list/fs_read, make changes with fs_write, and verify with exec
(install deps, run tests, builds, git). Keep going — calling tools across multiple steps — until the
task is actually complete, then give a short summary of what you did. If a command hangs, kill it with
exec_kill. Prefer small, verifiable changes and check your work by running the relevant command.`;

const MAX_STEPS = 20;

export interface AgentChatInput {
  prompt?: string;
  messages?: ModelMessage[];
  system?: string;
}

// The agent loop. streamText + stopWhen(stepCountIs) IS the "keep going until finished" mechanism:
// the model calls tools, the SDK executes them and feeds results back, and it repeats until the
// model stops calling tools (done) or hits the step cap. modelOverride is for tests (mock model).
export async function runAgentChat(env: Env, input: AgentChatInput, modelOverride?: LanguageModel) {
  const model = modelOverride ?? (await resolveModel(env)).model;
  return streamText({
    model,
    system: input.system || DEFAULT_SYSTEM,
    ...(input.messages?.length ? { messages: input.messages } : { prompt: input.prompt || "" }),
    tools: createTools(env),
    stopWhen: stepCountIs(MAX_STEPS),
  });
}
