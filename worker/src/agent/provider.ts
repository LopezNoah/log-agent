import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { decryptSecret } from "../crypto";
import type { Env } from "../env";

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

  const key = await decryptSecret(env, row.secret_ciphertext, row.secret_iv);
  const fullModel: string = (row.config ? safeParse(row.config) : {}).model || "";
  const modelId = fullModel.split("/").slice(1).join("/") || fullModel;

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

function safeParse(s: string): { model?: string } {
  try { return JSON.parse(s); } catch { return {}; }
}
