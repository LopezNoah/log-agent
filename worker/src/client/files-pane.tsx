import { createRoot, on, ref, type Handle } from "remix/ui";

// The files pane, ported to Remix 3 (remix/ui). Props-driven like the session rail and composer:
// the vanilla app (main.js) still owns ALL state + fs side-effects (fsApi calls, dirty/mtime
// bookkeeping, prompts/confirms, scheduled refreshes); this component is presentation + events
// only. main.js mounts it once into the files-pane body region and feeds props via
// mountFilesPane().update(); the editor is an uncontrolled textarea (like the composer input) whose
// content is driven imperatively via setEditor / clearEditor / getEditorValue.
//
// Layout boundary: this component renders the TOOLBAR (New file / New folder / Rename / Delete),
// the STATUS line, the file TREE, and the EDITOR section — i.e. everything inside <aside id=
// "files-pane"> EXCEPT its <header> (which holds #files-root and the #files-close / #files-refresh
// buttons; those stay owned by app.tsx + mobile.js, so this component does not render them). main.js
// passes onRefresh through for the header's refresh button to call if it wants, but the close button
// stays wired by mobile.js.
//
// Styling reuses the existing CSS verbatim: .files-toolbar, .files-status, .files-tree, .file-row
// (+ .dir/.file/.selected), .file-caret, .file-icon, .file-name, .file-editor, .file-editor-head,
// .file-editor-path, .file-editor-content, .file-editor-actions, .btn (+ ghost/primary/danger).

export interface FileNode {
  path: string;
  name: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface FilesPaneProps {
  // Tree data, mirrored from state.files. `root` is the workspace root node (whose children are
  // rendered at depth 0); null means nothing loaded yet (machine off / not refreshed).
  root: FileNode | null;
  // Paths currently expanded (state.files.expanded) and the selected path (state.files.selected).
  expanded: Set<string>;
  selected: string;
  // Status line text under the toolbar; empty string hides it (mirrors renderFiles(status)).
  status: string;
  // Whether the Fly box is up; gates the toolbar buttons (renderFiles's `disabled`).
  machineOn: boolean;
  // Whether a file is currently open (state.files.selectedType === "file" with editor shown). Drives
  // the editor section's visibility and the Rename/Delete/Save enabled state.
  editorOpen: boolean;
  // state.files.selectedType — Rename/Delete enable on any selection; Save only for a file.
  selectedType: "file" | "directory";
  // state.files.dirty — Save is enabled only when the open file has unsaved edits.
  dirty: boolean;

  // Tree interactions: clicking a file row vs. a directory row.
  onSelectFile: (path: string) => void;
  onToggleDir: (path: string) => void;
  // Toolbar actions. onDelete receives the clicked button so main.js can anchor confirmAction().
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: (anchor: HTMLElement) => void;
  onRefresh: () => void;
  onClose: () => void;
  // Editor actions: Save click, and every keystroke (so main.js can set dirty).
  onSave: () => void;
  onEditorInput: (value: string) => void;
}

function FilesPane(handle: Handle<FilesPaneProps>) {
  // Imperative handle onto the uncontrolled editor textarea. setEditor/clearEditor/getEditorValue
  // (exposed from mountFilesPane) drive it directly, exactly like the composer's input — keeping the
  // textarea uncontrolled so main.js's dirty tracking (via onEditorInput) stays authoritative.
  let editorEl: HTMLTextAreaElement | null = null;

  function renderNode(node: FileNode, depth: number): unknown {
    let p = handle.props;
    let isDir = node.type === "directory";
    let expanded = p.expanded.has(node.path);
    let selected = node.path === p.selected;
    let rowClass = "file-row" + (selected ? " selected" : "") + (isDir ? " dir" : " file");
    let caret = isDir ? (expanded ? "▾" : "▸") : "";
    let icon = isDir ? "□" : "·";

    return (
      <div key={node.path}>
        <button
          className={rowClass}
          style={`padding-left:${8 + depth * 16}px`}
          mix={on("click", () => {
            if (isDir) p.onToggleDir(node.path);
            else p.onSelectFile(node.path);
          })}
        >
          <span className="file-caret">{caret}</span>
          <span className="file-icon">{icon}</span>
          <span className="file-name">{node.name}</span>
        </button>
        {isDir && expanded ? (node.children || []).map((child) => renderNode(child, depth + 1)) : null}
      </div>
    );
  }

  return () => {
    let p = handle.props;
    let disabled = !p.machineOn;
    let rootChildren = p.root?.children || [];
    let empty = p.root && rootChildren.length === 0;
    // Mirror renderFiles: an empty workspace overrides the status line with a fixed message.
    let statusText = empty ? "Workspace is empty." : p.status;

    return (
      <>
        <div className="files-toolbar">
          <button
            id="files-new-file"
            className="btn btn-ghost"
            type="button"
            disabled={disabled}
            mix={on("click", () => p.onNewFile())}
          >
            New file
          </button>
          <button
            id="files-new-folder"
            className="btn btn-ghost"
            type="button"
            disabled={disabled}
            mix={on("click", () => p.onNewFolder())}
          >
            New folder
          </button>
          <button
            id="file-rename"
            className="btn btn-ghost"
            type="button"
            disabled={disabled || !p.selected}
            mix={on("click", () => p.onRename())}
          >
            Rename
          </button>
          <button
            id="file-delete"
            className="btn btn-ghost danger"
            type="button"
            disabled={disabled || !p.selected}
            mix={on("click", (event) => p.onDelete(event.currentTarget))}
          >
            Delete
          </button>
        </div>

        <div id="files-status" className="files-status" hidden={!statusText}>
          {statusText}
        </div>

        <div id="files-tree" className="files-tree" aria-label="Workspace files">
          {p.root ? rootChildren.map((child) => renderNode(child, 0)) : null}
        </div>

        <section id="file-editor" className="file-editor" hidden={!p.editorOpen}>
          <div className="file-editor-head">
            <div id="file-editor-path" className="file-editor-path">
              {p.selectedType === "file" ? p.selected : ""}
            </div>
          </div>
          <textarea
            id="file-editor-content"
            className="file-editor-content"
            spellCheck={false}
            mix={[
              ref((node: HTMLTextAreaElement) => {
                editorEl = node;
              }),
              on("input", (event) => p.onEditorInput(event.currentTarget.value)),
            ]}
          />
          <div className="file-editor-actions">
            <button
              id="file-save"
              className="btn btn-primary"
              type="button"
              disabled={disabled || !p.dirty || p.selectedType !== "file"}
              mix={on("click", () => p.onSave())}
            >
              Save
            </button>
          </div>
        </section>
      </>
    );
  };
}

// Mount the files pane once into a container and return an updater + imperative editor helpers the
// vanilla app calls. Re-rendering reconciles in place; the editor textarea stays uncontrolled, so
// its value is set/read via setEditor/clearEditor/getEditorValue rather than through props.
export function mountFilesPane(container: HTMLElement) {
  let root = createRoot(container);

  function editor(): HTMLTextAreaElement | null {
    return container.querySelector("#file-editor-content");
  }

  return {
    // Re-render with fresh props. Call this where main.js used to call renderFiles(status): pass the
    // current state.files projection + the status string (status maps to renderFiles's argument).
    update(props: FilesPaneProps) {
      root.render(<FilesPane {...props} />);
      root.flush();
    },
    // Open a file in the editor: set the textarea value (uncontrolled). The path shown in the head is
    // driven by props (selected + selectedType), so callers should update(...) with editorOpen=true
    // around this. Returns nothing.
    setEditor(_path: string, content: string) {
      let el = editor();
      if (el) el.value = content;
    },
    // Clear the editor textarea (e.g. after delete or losing selection).
    clearEditor() {
      let el = editor();
      if (el) el.value = "";
    },
    // Read the current editor contents for saving (replaces els.fileEditorContent.value).
    getEditorValue(): string {
      let el = editor();
      return el ? el.value : "";
    },
  };
}

export type FilesPaneController = ReturnType<typeof mountFilesPane>;
