import { createRoot, on, ref, type Handle } from "remix/ui";

// The chat THREAD, ported to Remix 3 (remix/ui). Like the session rail and composer, the vanilla
// app (main.js) still owns all state, the rich-content pipeline (markdown + ```ui artifacts + tool
// disclosures + diffs), and every action; this component is purely props-driven so it stays
// decoupled and unit-testable.
//
// Division of labour (deliberately conservative, to keep the proven pipeline intact):
//   - The OUTER #thread scroll container, its ResizeObserver, touch handlers, scroll-follow logic,
//     #thread-nav and #jump-bottom all STAY in main.js. This component only renders the INNER
//     content of #thread-content: the #empty placeholder, the pinned section, and the .msg list.
//   - Each message's rich BODY html is produced by main.js (renderUser/renderAssistant) and handed
//     in via props.renderBody(message): string. We render a leaf <div> for it and set its innerHTML
//     to that string, then call props.hydrate(bodyEl, message) so main.js can drain its artifact
//     mount-queue / pinned widgets into the freshly-inserted DOM. We never re-implement markdown,
//     artifacts, tools or diffs — we host the html main.js already builds.
//   - Per-message ACTIONS are TRUE Remix buttons wired to props.onAct(action, messageId, anchorEl).
//     This replaces the old delegated [data-act] click handler entirely.
//
// IMPORTANT about the body html: Remix reconciles its own vdom and will not look inside a node whose
// children we set via innerHTML. The `ref` callback only fires on INSERT, not on every re-render, so
// for streaming updates (same message id → same persistent .msg node) we cannot rely on it to
// refresh the body. We therefore keep a per-message content signature and, after every flush,
// re-apply the body html wherever it changed. main.js drives re-renders exactly as before (per token
// / per part), so streaming keeps working.

export interface ThreadMessage {
  // Mirrors the vanilla message entry: { info, parts, order }. We only read info here; renderBody /
  // hydrate get the whole entry so main.js can do whatever it already does.
  info: {
    id: string;
    role?: string;
    sessionID?: string;
    time?: { created?: number; completed?: number };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// One pinned artifact slot. main.js owns the spec + the mount; we just render the slot shell and
// hand the element back via mountPin so main.js can mountArtifact() into it.
export interface ThreadPin {
  domId: string; // stable DOM id, e.g. "pin_<sanitized-__id>"
  spec: unknown; // the UI artifact spec; opaque to us
}

export interface ThreadProps {
  // Messages already ordered by main.js (orderedMessages()). We render one .msg row per entry.
  messages: ThreadMessage[];
  // The created-time boundary for the revert UI: non-local messages at/after it get the `reverted`
  // class. 0 / null means no active revert. (Matches revertBoundaryCreated() in main.js.)
  revertBoundary: number | null;
  // Box state: gates whether per-message actions render at all (mirrors renderMsgActions()).
  machineOn: boolean;
  // Pinned artifacts for the active session (pinsFor(activeId) mapped to { domId, spec }).
  pins: ThreadPin[];

  // Rich-content pipeline, owned by main.js:
  //   renderBody(message) -> the inner html for the message body (renderUser/renderAssistant output,
  //                          i.e. role-aware: user bubble, or assistant md/artifacts/tools/usage).
  //   hydrate(bodyEl, message) -> drain main.js's artifact mount-queue into bodyEl (and anything
  //                          else that needs live DOM, e.g. re-wiring widgets) for this message.
  //   mountPin(slotEl, pin) -> mountArtifact() the pin's spec into its slot element.
  renderBody: (message: ThreadMessage) => string;
  hydrate: (bodyEl: HTMLElement, message: ThreadMessage) => void;
  mountPin: (slotEl: HTMLElement, pin: ThreadPin) => void;

  // Action callback. anchorEl is the clicked button (delete uses it as the confirm popover anchor).
  onAct: (action: ThreadAction, messageId: string, anchorEl?: HTMLElement) => void;
}

export type ThreadAction = "edit" | "revert" | "fork" | "copy" | "delete";

// Match renderMsgActions() exactly: which roles get which buttons, labels, titles, danger class.
function actionsFor(role: string | undefined): Array<{
  act: ThreadAction;
  label: string;
  title: string;
  danger?: boolean;
}> {
  const acts: Array<{ act: ThreadAction; label: string; title: string; danger?: boolean }> = [];
  if (role === "user") acts.push({ act: "edit", label: "✎", title: "Edit & resend" });
  acts.push({ act: "revert", label: "↶", title: "Revert to before this message" });
  acts.push({ act: "fork", label: "⑂", title: "Fork a new session here" });
  acts.push({ act: "copy", label: "⧉", title: "Copy text" });
  acts.push({ act: "delete", label: "🗑", title: "Delete message", danger: true });
  return acts;
}

function ThreadView(handle: Handle<ThreadProps>) {
  // Per-message body signature, so after a re-render we only re-apply (and re-hydrate) bodies whose
  // html actually changed — cheap, and it keeps streaming from re-running artifact mounts needlessly.
  // Lives across renders (the closure is the component instance).
  let bodySig = new Map<string, string>();
  // bodyEls/pinEls: the live DOM nodes captured via ref, keyed so the mount wrapper can refresh them
  // after each flush (ref only fires on insert, not on update).
  let bodyEls = new Map<string, HTMLElement>();
  let pinEls = new Map<string, HTMLElement>();

  // Apply renderBody+hydrate to a freshly-inserted (or changed) body node.
  function paintBody(el: HTMLElement, message: ThreadMessage) {
    const html = handle.props.renderBody(message);
    el.innerHTML = html;
    bodySig.set(message.info.id, html);
    handle.props.hydrate(el, message);
  }

  // Called by the mount wrapper after each flush: re-apply bodies whose html changed (streaming) and
  // prune signatures for messages that are gone.
  function refreshBodies() {
    const live = new Set<string>();
    for (const m of handle.props.messages) {
      live.add(m.info.id);
      const el = bodyEls.get(m.info.id);
      if (!el || !el.isConnected) continue;
      const next = handle.props.renderBody(m);
      if (bodySig.get(m.info.id) !== next) {
        el.innerHTML = next;
        bodySig.set(m.info.id, next);
        handle.props.hydrate(el, m);
      }
    }
    for (const id of [...bodySig.keys()]) if (!live.has(id)) bodySig.delete(id);
    for (const id of [...bodyEls.keys()]) if (!live.has(id)) bodyEls.delete(id);
  }

  // Re-mount every pinned slot after a flush (pins are re-built from scratch each render, like the
  // vanilla renderPinned()).
  function refreshPins() {
    for (const pin of handle.props.pins) {
      const el = pinEls.get(pin.domId);
      if (el && el.isConnected && el.childElementCount === 0) handle.props.mountPin(el, pin);
    }
    const live = new Set(handle.props.pins.map((p) => p.domId));
    for (const id of [...pinEls.keys()]) if (!live.has(id)) pinEls.delete(id);
  }

  // Expose the post-flush hooks on the handle so mountThread can invoke them. (Stashed on a symbol-ish
  // field to avoid clashing with Handle's own members.)
  (handle as unknown as { __refresh?: () => void }).__refresh = () => {
    refreshBodies();
    refreshPins();
  };

  const render = () => {
    const p = handle.props;
    const hasMessages = p.messages.length > 0;

    return (
      <>
        {/* The #empty placeholder lives here now (it used to be static markup in app.tsx). main.js
            no longer toggles els.empty.style.display — visibility is derived from messages. */}
        <div
          id="empty"
          className="h-full flex flex-col items-center justify-center text-center text-muted px-6"
          hidden={hasMessages}
        >
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-100 mb-2">opencode phone</h1>
          <p>A cloud computer for your agents. Pick a session or start a new one.</p>
        </div>

        {p.pins.length > 0 && (
          <div className="msg pinned-section">
            <div className="role">{"📌 pinned"}</div>
            {p.pins.map((pin) => (
              <div
                key={pin.domId}
                id={pin.domId}
                className="artifact-slot"
                mix={ref((node: HTMLElement) => {
                  pinEls.set(pin.domId, node);
                  if (node.childElementCount === 0) p.mountPin(node, pin);
                })}
              ></div>
            ))}
          </div>
        )}

        {p.messages.map((m) => {
          const role = m.info.role || "assistant";
          const local = !!m.info.id && m.info.id.startsWith("local-");
          const reverted =
            !!p.revertBoundary && !local && (m.info.time?.created || 0) >= p.revertBoundary;
          let cls = "msg " + role;
          if (reverted) cls += " reverted";

          // renderMsgActions(): skipped for the optimistic local bubble and while the box is off.
          const showActions = p.machineOn && !local;

          return (
            <div key={m.info.id} className={cls} data-mid={m.info.id}>
              <div className="role">{role}</div>
              <div
                className="msg-body"
                mix={ref((node: HTMLElement) => {
                  bodyEls.set(m.info.id, node);
                  paintBody(node, m);
                })}
              ></div>
              {showActions && (
                <div className="msg-actions">
                  {actionsFor(role).map((a) => (
                    <button
                      key={a.act}
                      className={"msg-act" + (a.danger ? " danger" : "")}
                      type="button"
                      title={a.title}
                      mix={on("click", (event) => p.onAct(a.act, m.info.id, event.currentTarget as HTMLElement))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  return render;
}

// Mount the thread content once into #thread-content and return an updater + a couple of imperative
// helpers main.js's scroll code needs. Re-rendering reconciles in place; after each flush we refresh
// any message bodies whose html changed (streaming) and re-mount pinned slots.
export function mountThread(container: HTMLElement) {
  // Capture each instance's post-flush refresh hook. We pass the same handle object Remix gives the
  // component (it stashes __refresh on it), but since we don't have direct access to the handle we
  // route through a module-local ref set inside the component via the wrapper below.
  let refresh: (() => void) | null = null;

  // Wrap ThreadView so we can grab its handle (and thus its __refresh) on first construction.
  function Thread(handle: Handle<ThreadProps>) {
    const inner = ThreadView(handle);
    refresh = (handle as unknown as { __refresh?: () => void }).__refresh ?? null;
    return inner;
  }

  const root = createRoot(container);

  return {
    update(props: ThreadProps) {
      root.render(<Thread {...props} />);
      root.flush();
      // After the vdom is in place, refresh imperatively-owned content (bodies whose html changed,
      // pinned slots). On the first render the ref callbacks already painted everything; this catches
      // subsequent streaming updates where the .msg node persists and ref does not re-fire.
      refresh?.();
    },
    // main.js's scroll-follow / nav code queries .msg[data-mid=...] — expose the same lookup against
    // the mounted content so it doesn't need to know our internals.
    msgNode(mid: string): HTMLElement | null {
      return mid ? container.querySelector(`.msg[data-mid="${mid}"]`) : null;
    },
    // The #empty node is now rendered by this component; expose it for any code that still wants it.
    empty(): HTMLElement | null {
      return container.querySelector("#empty");
    },
  };
}
