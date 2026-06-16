import { createRoot, on, ref, type Handle } from "remix/ui";

// The composer, ported to Remix 3 (remix/ui). Props-driven like the session rail: the vanilla app
// owns state + actions and feeds props via mountComposer().update(); the component owns the input,
// auto-grow, the Safari readonly autofill fix, and wiring buttons/keys to the callbacks. Visibility
// is still toggled by the vanilla updateMode() via the #composer container's `hidden`.

export interface Agent {
  name: string;
  label: string;
}

// Which engine handles a send: "opencode" (the box) or "worker" (the Worker-side agent endpoint).
export type Brain = "opencode" | "worker";

export interface ComposerProps {
  busy: boolean;
  reverted: boolean;
  agents: Agent[];
  selectedAgent: string | null;
  autoApprove: boolean;
  // Brain toggle (opt-in). Defaults to "opencode" upstream so the existing send path is untouched.
  brain: Brain;
  // Worker-brain model picker (shown only when brain === "worker"); sent with each /api/agent/chat.
  workerModel: string;
  workerModels: string[];
  onSend: (text: string) => void;
  onStop: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCompact: () => void;
  onFork: () => void;
  onAgentChange: (name: string) => void;
  onAutoApproveChange: (checked: boolean) => void;
  onBrainChange: (brain: Brain) => void;
  onWorkerModelChange: (model: string) => void;
}

function Composer(handle: Handle<ComposerProps>) {
  let inputEl: HTMLTextAreaElement | null = null;

  function autoGrow() {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
  }

  function trySend() {
    if (handle.props.busy || !inputEl) return; // generating — Stop (Esc) first
    let text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    autoGrow();
    handle.props.onSend(text);
  }

  return () => {
    let p = handle.props;

    return (
      <div className="mx-auto w-full max-w-3xl">
        {p.reverted && (
          <div className="revert-banner">
            <span>↩ Reverted — later messages are hidden. Send a message to keep this point, or redo.</span>
            <button className="btn btn-ghost" type="button" mix={on("click", () => p.onRedo())}>
              ↷ Redo
            </button>
          </div>
        )}
        <div className="composer-bar">
          <div className="composer-tools">
            <button className="msg-act" type="button" title="Undo the last turn (revert)" mix={on("click", () => p.onUndo())}>
              ↶ Undo
            </button>
            {p.reverted && (
              <button className="msg-act" type="button" title="Redo (unrevert)" mix={on("click", () => p.onRedo())}>
                ↷ Redo
              </button>
            )}
            <button
              className="msg-act"
              type="button"
              title="Compact the conversation (summarize to free context)"
              mix={on("click", () => p.onCompact())}
            >
              ⊟ Compact
            </button>
            <button className="msg-act" type="button" title="Fork this session into a new one" mix={on("click", () => p.onFork())}>
              ⑂ Fork
            </button>
          </div>

          <textarea
            className="w-full bg-transparent outline-none resize-none max-h-56 py-0.5"
            placeholder="Message opencode…  (Enter to send · Shift+Enter for newline)"
            mix={[
              ref((node: HTMLTextAreaElement) => {
                inputEl = node;
                node.setAttribute("name", "prompt");
                node.setAttribute("rows", "1");
                // Autofill opt-outs + the Safari readonly trick (removed on focus, restored on blur).
                node.setAttribute("autocomplete", "off");
                node.setAttribute("autocapitalize", "sentences");
                node.setAttribute("autocorrect", "on");
                node.setAttribute("spellcheck", "true");
                node.setAttribute("data-1p-ignore", "");
                node.setAttribute("data-lpignore", "true");
                node.setAttribute("data-bwignore", "");
                node.setAttribute("data-form-type", "other");
                node.setAttribute("readonly", "");
              }),
              on("focus", (event) => event.currentTarget.removeAttribute("readonly")),
              on("blur", (event) => event.currentTarget.setAttribute("readonly", "")),
              on("input", () => autoGrow()),
              on("keydown", (event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  trySend();
                } else if (event.key === "Escape" && handle.props.busy) {
                  event.preventDefault();
                  handle.props.onStop();
                }
              }),
            ]}
          />

          <div className="flex items-center gap-2 mt-2">
            <select
              className="agent-select brain-select"
              title="Which brain handles your message — opencode (the box) or the Worker-side agent"
              value={p.brain}
              mix={on("change", (event) => p.onBrainChange(event.currentTarget.value as Brain))}
            >
              <option value="opencode">🧠 opencode</option>
              <option value="worker">⚡ worker</option>
            </select>
            {p.brain === "worker" && (
              <select
                className="agent-select"
                title="Worker-brain model"
                value={p.workerModel}
                mix={on("change", (event) => p.onWorkerModelChange(event.currentTarget.value))}
              >
                {p.workerModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
            <select
              className="agent-select"
              title="Agent mode"
              value={p.selectedAgent ?? ""}
              mix={on("change", (event) => p.onAgentChange(event.currentTarget.value))}
            >
              {p.agents.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.label}
                </option>
              ))}
            </select>
            <label
              className="auto-toggle"
              title="Auto-approve every tool action in this session (no prompts) — for unattended runs"
            >
              <input
                type="checkbox"
                checked={p.autoApprove}
                mix={on("change", (event) => p.onAutoApproveChange(event.currentTarget.checked))}
              />{" "}
              ⚡ Auto-approve
            </label>
            {p.busy ? (
              <button className="btn btn-stop ml-auto" type="button" title="Stop generating (Esc)" mix={on("click", () => p.onStop())}>
                ■ Stop
              </button>
            ) : (
              <button className="btn btn-primary ml-auto" type="button" mix={on("click", () => trySend())}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };
}

export function mountComposer(container: HTMLElement) {
  let root = createRoot(container);

  function textarea(): HTMLTextAreaElement | null {
    return container.querySelector("textarea");
  }
  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }

  return {
    update(props: ComposerProps) {
      root.render(<Composer {...props} />);
      root.flush();
    },
    // Prefill + focus the input (used by "edit & resend").
    setInput(text: string) {
      let el = textarea();
      if (!el) return;
      el.removeAttribute("readonly");
      el.value = text;
      autoGrow(el);
      el.focus();
    },
    focusInput() {
      let el = textarea();
      if (!el) return;
      el.removeAttribute("readonly");
      el.focus();
    },
  };
}
