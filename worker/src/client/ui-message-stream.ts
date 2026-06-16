// Parser for the AI SDK v6 UI-message stream emitted by `toUIMessageStreamResponse()`.
//
// Wire format (confirmed against worker/node_modules/ai/dist — JsonToSseTransformStream):
//   - The body is an SSE stream: each event is a line `data: <json>\n\n`.
//   - The final event is the literal `data: [DONE]\n\n`.
//   - Each `<json>` is a `UIMessageChunk` discriminated by `type`. The chunks this app cares about:
//       text-start / text-delta / text-end          → assistant text, keyed by `id`
//       reasoning-start / reasoning-delta / -end     → reasoning (rendered like text)
//       tool-input-start                             → a tool call begins (toolCallId, toolName, title?)
//       tool-input-available                         → the tool's full input is known (input)
//       tool-input-delta                             → partial JSON input text (inputTextDelta)
//       tool-output-available                        → the tool result (output)
//       tool-output-error                            → the tool errored (errorText)
//       error                                        → a stream-level error (errorText)
//       start / finish / start-step / finish-step    → lifecycle (we only need `finish`)
//
// This module is intentionally framework-free so it can be unit-tested against a raw chunk sequence.
// `parseSseLines` turns a sequence of decoded text chunks into individual JSON UIMessageChunk
// objects; `applyChunk` folds one chunk into an accumulator the thread can render.

export type UIMessageChunk = {
  type: string;
  // text/reasoning
  id?: string;
  delta?: string;
  // tools
  toolCallId?: string;
  toolName?: string;
  title?: string;
  input?: unknown;
  inputTextDelta?: string;
  output?: unknown;
  // errors
  errorText?: string;
  // lifecycle
  finishReason?: string;
  [k: string]: unknown;
};

// Incremental SSE framing decoder. Feed it raw decoded text (any chunk boundaries); it returns the
// complete UIMessageChunk JSON objects parsed so far and buffers any partial trailing line. `[DONE]`
// is swallowed (it is not a chunk). Call with "" to flush nothing — the buffer persists on `this`.
export function createSseParser() {
  let buffer = "";
  return {
    // Push a decoded text chunk; returns the chunks that completed in this push.
    push(text: string): UIMessageChunk[] {
      buffer += text;
      const out: UIMessageChunk[] = [];
      // SSE events are separated by a blank line. Split on \n\n, keep the remainder buffered.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const chunk = parseEvent(rawEvent);
        if (chunk) out.push(chunk);
      }
      return out;
    },
    // Flush any trailing event not terminated by a blank line (defensive — the AI SDK always
    // terminates, but a truncated stream shouldn't drop a final chunk).
    flush(): UIMessageChunk[] {
      const rest = buffer.trim();
      buffer = "";
      if (!rest) return [];
      const chunk = parseEvent(rest);
      return chunk ? [chunk] : [];
    },
  };
}

// Parse a single raw SSE event block (possibly multiple `data:` lines) into one UIMessageChunk.
function parseEvent(rawEvent: string): UIMessageChunk | null {
  // An event may have several lines; we only consume `data:` lines (SSE allows multi-line data,
  // joined by \n). Ignore comments / other field lines.
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as UIMessageChunk;
  } catch {
    return null; // tolerate a malformed line rather than aborting the whole stream
  }
}

// A tool's accumulated state, shaped to match what the thread's renderTool() reads from an opencode
// "tool" part: { type:"tool", id, tool, state:{ status, title, input, output, error } }.
export interface ToolAcc {
  type: "tool";
  id: string;
  tool: string;
  state: {
    status: "pending" | "running" | "completed" | "error";
    title?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  };
}

// The accumulator mirrors a single assistant message: an ordered list of parts (text / reasoning /
// tool), with text/reasoning coalesced per `id` and tools tracked by `toolCallId`. The thread can
// render this directly via the existing renderAssistant pipeline (it reads p.type / p.text / p.tool
// / p.state). `done` flips on the `finish` chunk; `error` holds any stream-level error text.
export interface StreamAcc {
  // part id -> part. order preserves insertion for stable rendering.
  parts: Map<string, { type: string; text?: string } | ToolAcc>;
  order: string[];
  done: boolean;
  error: string | null;
}

export function createAcc(): StreamAcc {
  return { parts: new Map(), order: [], done: false, error: null };
}

function ensure(acc: StreamAcc, id: string, make: () => { type: string; text?: string } | ToolAcc) {
  let part = acc.parts.get(id);
  if (!part) {
    part = make();
    acc.parts.set(id, part);
    acc.order.push(id);
  }
  return part;
}

// Fold one chunk into the accumulator. Returns true if anything renderable changed (so the caller
// can re-render). Lifecycle-only chunks (start, start-step, finish-step) return false.
export function applyChunk(acc: StreamAcc, chunk: UIMessageChunk): boolean {
  switch (chunk.type) {
    case "text-start": {
      ensure(acc, "text-" + (chunk.id ?? "0"), () => ({ type: "text", text: "" }));
      return true;
    }
    case "text-delta": {
      const part = ensure(acc, "text-" + (chunk.id ?? "0"), () => ({ type: "text", text: "" })) as {
        type: string;
        text?: string;
      };
      part.text = (part.text ?? "") + (chunk.delta ?? "");
      return true;
    }
    case "reasoning-start": {
      ensure(acc, "reasoning-" + (chunk.id ?? "0"), () => ({ type: "reasoning", text: "" }));
      return true;
    }
    case "reasoning-delta": {
      const part = ensure(acc, "reasoning-" + (chunk.id ?? "0"), () => ({
        type: "reasoning",
        text: "",
      })) as { type: string; text?: string };
      part.text = (part.text ?? "") + (chunk.delta ?? "");
      return true;
    }
    case "tool-input-start": {
      const id = chunk.toolCallId ?? "tool-" + acc.order.length;
      ensure(acc, id, () => ({
        type: "tool",
        id,
        tool: chunk.toolName ?? "tool",
        state: { status: "running", title: chunk.title },
      }));
      return true;
    }
    case "tool-input-delta": {
      // Partial JSON input text; surface it so the user sees the call forming. We append to a string
      // input — once tool-input-available lands it overwrites with the parsed object.
      const id = chunk.toolCallId ?? "";
      const part = acc.parts.get(id) as ToolAcc | undefined;
      if (!part || part.type !== "tool") return false;
      const prev = typeof part.state.input === "string" ? part.state.input : "";
      part.state.input = prev + (chunk.inputTextDelta ?? "");
      return true;
    }
    case "tool-input-available": {
      const id = chunk.toolCallId ?? "tool-" + acc.order.length;
      const part = ensure(acc, id, () => ({
        type: "tool",
        id,
        tool: chunk.toolName ?? "tool",
        state: { status: "running" },
      })) as ToolAcc;
      part.tool = chunk.toolName ?? part.tool;
      part.state.input = chunk.input;
      if (chunk.title) part.state.title = chunk.title;
      part.state.status = "running";
      return true;
    }
    case "tool-output-available": {
      const id = chunk.toolCallId ?? "";
      const part = acc.parts.get(id) as ToolAcc | undefined;
      if (!part || part.type !== "tool") return false;
      part.state.output = chunk.output;
      part.state.status = "completed";
      return true;
    }
    case "tool-output-error": {
      const id = chunk.toolCallId ?? "";
      const part = acc.parts.get(id) as ToolAcc | undefined;
      if (!part || part.type !== "tool") return false;
      part.state.error = chunk.errorText ?? "error";
      part.state.status = "error";
      return true;
    }
    case "error": {
      acc.error = chunk.errorText ?? "stream error";
      return true;
    }
    case "finish":
    case "abort": {
      acc.done = true;
      return true;
    }
    default:
      // start / start-step / finish-step / message-metadata / source-* / file / text-end /
      // reasoning-end — nothing renderable to fold.
      return false;
  }
}
