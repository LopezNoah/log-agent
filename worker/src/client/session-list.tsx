import { createRoot, on, ref, type Handle } from "remix/ui";

// First screen ported to Remix 3 (remix/ui). The vanilla app still owns state + actions; this
// component is purely props-driven so it stays decoupled and unit-testable. main.js mounts it once
// into #session-list and re-renders it (via mountSessionList's updater) whenever sessions change.
// Styling reuses the existing .session-item / .session-open / .session-act classes from styles.css.

export interface SessionItem {
  id: string;
  title?: string;
  time?: unknown;
}

export interface SessionListProps {
  sessions: SessionItem[];
  activeId: string | null;
  fmtTime: (time: unknown) => string;
  onSelect: (id: string) => void;
  onRename: (session: SessionItem, title: string) => void;
  onDelete: (session: SessionItem, anchor: HTMLElement) => void;
}

function SessionList(handle: Handle<SessionListProps>) {
  // Component-local UI state: which row (if any) is being renamed, and a one-shot guard so the
  // commit-on-Enter / cancel-on-Escape / commit-on-blur trio resolves exactly once (mirrors the
  // old `done` flag).
  let editingId: string | null = null;
  let editResolved = false;

  function startEdit(id: string) {
    editingId = id;
    editResolved = false;
    handle.update();
  }

  function endEdit() {
    editingId = null;
    handle.update();
  }

  return () => {
    let { sessions, activeId, fmtTime, onSelect, onRename, onDelete } = handle.props;

    return (
      <>
        {sessions.map((session) => {
          let active = session.id === activeId;
          let rowClass = "session-item" + (active ? " active" : "");

          if (editingId === session.id) {
            let commit = (save: boolean, value: string) => {
              if (editResolved) return;
              editResolved = true;
              if (save) onRename(session, value);
              endEdit();
            };
            return (
              <div key={session.id} className={rowClass}>
                <input
                  className="session-rename"
                  mix={[
                    ref((node: HTMLInputElement) => {
                      node.value = session.title ?? "";
                      node.focus();
                      node.select();
                    }),
                    on("keydown", (event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commit(true, event.currentTarget.value);
                      } else if (event.key === "Escape") {
                        commit(false, "");
                      }
                    }),
                    on("blur", (event) => commit(true, event.currentTarget.value)),
                  ]}
                />
              </div>
            );
          }

          return (
            <div key={session.id} className={rowClass}>
              <button
                className="session-open"
                mix={[
                  on("click", () => onSelect(session.id)),
                  on("dblclick", (event) => {
                    event.preventDefault();
                    startEdit(session.id);
                  }),
                ]}
              >
                <span className="title">{session.title || "Untitled session"}</span>
                <span className="ts">{fmtTime(session.time)}</span>
              </button>
              <div className="session-actions">
                <button
                  className="session-act"
                  title="Rename"
                  mix={on("click", (event) => {
                    event.stopPropagation();
                    startEdit(session.id);
                  })}
                >
                  ✎
                </button>
                <button
                  className="session-act danger"
                  title="Delete"
                  mix={on("click", (event) => {
                    event.stopPropagation();
                    onDelete(session, event.currentTarget);
                  })}
                >
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </>
    );
  };
}

// Mount the rail once into a container and return an updater the vanilla app calls with fresh
// props. Re-rendering reconciles in place, so a session refresh mid-rename keeps the edit input.
export function mountSessionList(container: HTMLElement) {
  let root = createRoot(container);
  return (props: SessionListProps) => {
    root.render(<SessionList {...props} />);
    root.flush();
  };
}
