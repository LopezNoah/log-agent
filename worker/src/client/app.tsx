import { createRoot, type Handle } from "remix/ui";

// Root layout, ported from the old static AppShell.astro markup into a Remix (remix/ui) component.
// It renders the full app structure with the SAME element ids/classes the rest of the app expects,
// so main.js's renderers (thread, files, machine, overlays) and the mounted island components
// (session rail -> #session-list, composer -> #composer) keep working against these nodes. main.js
// mounts this once into #root before anything else runs (dom.js resolves els lazily afterward).
// Static structure — no props, never re-renders; dynamic content is filled in by main.js.

function App(_handle: Handle) {
  return () => (
    <>
      <div id="app" className="grid h-dvh grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)_320px]">
        <button id="menu-toggle" className="menu-toggle md:hidden" aria-label="Toggle sessions">☰</button>
        <button id="files-toggle" className="files-toggle md:hidden" aria-label="Toggle files">Files</button>
        <div id="scrim" className="fixed inset-0 z-[35] bg-black/50 backdrop-blur-sm md:hidden" hidden={true}></div>

        <aside id="sidebar" className="sidebar flex flex-col min-h-0 bg-panel border-r border-line">
          <header className="flex items-center justify-between px-4 py-3 border-b border-line">
            <div className="font-semibold tracking-tight">opencode<span className="text-muted ml-1 font-medium">phone</span></div>
            <button id="new-session" className="btn btn-primary h-9 w-9 p-0 text-lg" title="New session">＋</button>
          </header>
          {/* Remix session rail mounts here (src/client/session-list.tsx) */}
          <div id="session-list" className="flex-1 overflow-y-auto p-2 min-h-0"></div>
          <footer className="border-t border-line px-3.5 py-3">
            <div className="flex items-center gap-2 text-[13px] text-muted mb-2.5">
              <span id="machine-dot" className="dot"></span>
              <span id="machine-state">…</span>
            </div>
            <div className="flex gap-2">
              <button id="machine-toggle" className="btn btn-ghost flex-1">Start</button>
              <a className="btn btn-ghost flex-1 text-center" href="/terminal/" target="_blank" rel="noopener">Terminal ↗</a>
            </div>
            <button id="open-github-project" className="btn btn-primary w-full mt-2">New GitHub repo</button>
            <button id="open-settings" className="btn btn-ghost w-full mt-2">⚙ Settings</button>
          </footer>
        </aside>

        <main className="flex flex-col min-w-0 min-h-0 relative">
          <div id="usage-total" className="usage-total" hidden={true}></div>
          <div id="thread" className="flex-1 overflow-y-auto pt-7 pb-2 max-md:pt-16 min-h-0">
            {/* Remix thread mounts here (src/client/thread.tsx); it renders #empty + .msg list + pins */}
            <div id="thread-content" className="min-h-full"></div>
          </div>

          <button id="jump-bottom" className="jump-bottom" type="button" hidden={true}>↓ Latest</button>
          <div id="thread-nav" className="thread-nav" hidden={true} aria-label="Jump to prompt"></div>

          <div id="offline-banner" className="offline-banner" hidden={true}></div>

          {/* Remix composer mounts here (src/client/composer.tsx); updateMode() toggles `hidden` */}
          <div id="composer" className="composer" hidden={true}></div>
        </main>

        <aside id="files-pane" className="files-pane flex flex-col min-h-0 bg-panel border-l border-line">
          <header className="files-head">
            <div>
              <div className="font-semibold tracking-tight">Files</div>
              <div id="files-root" className="files-root">/workspace</div>
            </div>
            <div className="files-actions">
              <button id="files-refresh" className="widget-act" title="Refresh files">↻</button>
              <button id="files-close" className="widget-act md:hidden" title="Close files">✕</button>
            </div>
          </header>
          {/* Remix files pane mounts here (src/client/files-pane.tsx); it renders the toolbar,
              status line, tree, and editor section (with the same ids) inside this host. */}
          <div id="files-host" className="contents"></div>
        </aside>
      </div>

      <div id="settings-overlay" className="settings-overlay" hidden={true}>
        <div className="settings-shell">
          <nav id="settings-nav" className="settings-nav">
            <div className="settings-nav-header">
              <div className="settings-nav-title">Settings</div>
              <button id="settings-close" className="settings-close" aria-label="Close settings">✕</button>
            </div>
            <div id="settings-nav-items" className="settings-nav-items"></div>
          </nav>
          <div id="settings-content" className="settings-content"></div>
        </div>
      </div>

      <div id="github-project-overlay" className="github-project-overlay" hidden={true}>
        <section className="github-project-shell" aria-labelledby="github-project-title">
          <header className="github-project-head">
            <div>
              <p className="github-project-eyebrow">Worker-owned GitHub</p>
              <h2 id="github-project-title">Create a new repo with the cloud agent</h2>
              <p>Draft the MVP flow where Fly builds the project and the Worker creates the GitHub repo and initial commit.</p>
            </div>
            <button id="github-project-close" className="settings-close" aria-label="Close new repo dialog">✕</button>
          </header>

          <form id="github-project-form" className="github-project-form">
            <div className="github-project-grid">
              <label className="settings-field">
                <span>Owner</span>
                <input id="github-project-owner" className="field" autoComplete="off" placeholder="octocat or my-org" required={true} />
              </label>
              <label className="settings-field">
                <span>Repository name</span>
                <input id="github-project-name" className="field" autoComplete="off" placeholder="agent-built-app" required={true} />
              </label>
            </div>

            <label className="settings-field">
              <span>Description</span>
              <input id="github-project-description" className="field" placeholder="Short description for GitHub" />
            </label>

            <div className="github-project-grid">
              <label className="settings-field">
                <span>Visibility</span>
                <select id="github-project-visibility" className="field">
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Default branch</span>
                <input id="github-project-branch" className="field" value="main" autoComplete="off" required={true} />
              </label>
            </div>

            <label className="settings-field">
              <span>Project brief</span>
              <textarea id="github-project-prompt" className="field github-project-prompt" rows={6} placeholder="Describe the app, stack, constraints, and what should be in the initial commit." required={true}></textarea>
            </label>

            <label className="auto-toggle github-project-check" title="Ask the runner to execute detected install/build/test commands before packaging the artifact.">
              <input id="github-project-run-tests" type="checkbox" checked={true} /> Run detected checks before upload
            </label>

            <div className="github-project-actions">
              <button className="btn btn-ghost" type="button" id="github-project-reset">Reset</button>
              <button className="btn btn-primary" type="submit">Draft task</button>
            </div>
          </form>

          <aside className="github-project-preview" aria-live="polite">
            <h3>Planned orchestration</h3>
            <div id="github-project-steps" className="github-project-steps"></div>
            <div id="github-project-payload" className="github-project-payload" hidden={true}></div>
          </aside>
        </section>
      </div>
    </>
  );
}

// Mount the layout once into the given container (#root). Static render, no updates.
export function mountApp(container: HTMLElement) {
  let root = createRoot(container);
  root.render(<App />);
  root.flush();
  return root;
}
