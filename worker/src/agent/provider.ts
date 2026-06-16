import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { decryptSecret } from "../crypto";
import type { Env } from "../env";
import {
  CHATGPT_CODEX_BASE,
  createCodexFetch,
  refreshTokens,
  type ChatGptTokens,
} from "./chatgpt-oauth";
import {
  DEFAULT_CHATGPT_MODEL,
  OPENAI_CHATGPT_PROVIDER,
  readChatGptBundle,
  updateChatGptBundle,
} from "../connectors";

interface LlmRow {
  provider: string;
  config: string | null;
  secret_ciphertext: string;
  secret_iv: string;
}

// Resolve the user's default LLM connector (D1, AES-GCM) into an AI SDK model — decrypting the key
// in the Worker only. config.model is "provider/modelID" (e.g. "anthropic/claude-sonnet-4-6"); the
// SDK model id is everything after the connector-provider prefix (openrouter keeps its own
// provider-prefixed ids, which falls out naturally).
export async function resolveModel(env: Env): Promise<{ model: LanguageModel; label: string }> {
  const row = await env.DB.prepare(
    "SELECT provider, config, secret_ciphertext, secret_iv FROM connectors WHERE type = 'llm' AND is_default = 1",
  ).first<LlmRow>();
  if (!row) throw new Error("no_default_llm_connector");

  const fullModel: string = (row.config ? safeParse(row.config) : {}).model || "";
  const modelId = fullModel.split("/").slice(1).join("/") || fullModel;

  // ChatGPT-subscription OAuth: the secret is an encrypted OAuth bundle (not an API key). Build a
  // codex-backed model whose custom fetch injects the bearer token + ChatGPT-Account-Id and
  // refreshes/persists tokens to D1. Resolve before the generic decryptSecret below.
  if (row.provider === OPENAI_CHATGPT_PROVIDER) {
    return { model: await chatGptModel(env, modelId || fullModel), label: fullModel || `${OPENAI_CHATGPT_PROVIDER}/${DEFAULT_CHATGPT_MODEL}` };
  }

  const key = await decryptSecret(env, row.secret_ciphertext, row.secret_iv);

  switch (row.provider) {
    case "anthropic":
      return { model: createAnthropic({ apiKey: key })(modelId || "claude-sonnet-4-6"), label: fullModel };
    case "openai":
      return { model: createOpenAI({ apiKey: key })(modelId || "gpt-4o"), label: fullModel };
    case "openrouter":
      return { model: createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: key })(modelId), label: fullModel };
    case "groq":
      return { model: createOpenAICompatible({ name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: key })(modelId), label: fullModel };
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey: key })(modelId || "gemini-2.0-flash"), label: fullModel };
    default:
      throw new Error("unsupported_provider:" + row.provider);
  }
}

// Build a codex-backed responses model from the stored ChatGPT OAuth bundle. The custom fetch
// (createCodexFetch) owns auth: it reads the bundle from D1, refreshes+persists on expiry, sets
// Authorization/ChatGPT-Account-Id, and rewrites the URL to the codex endpoint. We pass the
// current access token as apiKey purely so the SDK populates a placeholder Authorization header
// (which the fetch wrapper then overwrites); a non-empty value keeps the SDK from throwing.
async function chatGptModel(env: Env, modelId: string): Promise<LanguageModel> {
  const initial = await readChatGptBundle(env);
  const codexFetch = createCodexFetch({
    getTokens: async (): Promise<ChatGptTokens> => readChatGptBundle(env),
    saveTokens: async (tokens: ChatGptTokens) => updateChatGptBundle(env, tokens),
  });
  const provider = createOpenAI({
    baseURL: CHATGPT_CODEX_BASE,
    apiKey: initial.access || "chatgpt-oauth",
    headers: { originator: "opencode" },
    fetch: codexFetch,
  });
  return provider.responses(modelId || DEFAULT_CHATGPT_MODEL);
}

// Single-flight refresh entry-point exported for callers that want to proactively refresh the
// stored bundle (kept for completeness / future use).
export async function refreshChatGptBundle(env: Env): Promise<ChatGptTokens> {
  const current = await readChatGptBundle(env);
  const fresh = await refreshTokens(current.refresh);
  if (!fresh.accountId) fresh.accountId = current.accountId;
  await updateChatGptBundle(env, fresh);
  return fresh;
}

function safeParse(s: string): { model?: string } {
  try { return JSON.parse(s); } catch { return {}; }
}
