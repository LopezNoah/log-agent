export const $ = (sel) => document.querySelector(sel);

// The layout is rendered by the Remix <App> component (src/client/app.tsx), which main.js mounts
// before any other code runs — so these nodes do NOT exist at module-load time. `els.<name>` is
// therefore resolved lazily on access (and re-queried if a cached node was detached), letting the
// rest of the app keep using `els.*` exactly as before, now against the Remix-rendered DOM.
const SELECTORS = {
  sidebar: "#sidebar",
  filesPane: "#files-pane",
  menuToggle: "#menu-toggle",
  filesToggle: "#files-toggle",
  scrim: "#scrim",
  sessionList: "#session-list",
  thread: "#thread",
  threadContent: "#thread-content",
  usageTotal: "#usage-total",
  empty: "#empty",
  threadNav: "#thread-nav",
  jumpBottom: "#jump-bottom",
  composer: "#composer",
  offlineBanner: "#offline-banner",
  newSession: "#new-session",
  machineDot: "#machine-dot",
  machineState: "#machine-state",
  machineToggle: "#machine-toggle",
  openGithubProject: "#open-github-project",
  githubProjectOverlay: "#github-project-overlay",
  githubProjectClose: "#github-project-close",
  githubProjectForm: "#github-project-form",
  githubProjectOwner: "#github-project-owner",
  githubProjectName: "#github-project-name",
  githubProjectDescription: "#github-project-description",
  githubProjectVisibility: "#github-project-visibility",
  githubProjectBranch: "#github-project-branch",
  githubProjectPrompt: "#github-project-prompt",
  githubProjectRunTests: "#github-project-run-tests",
  githubProjectReset: "#github-project-reset",
  githubProjectSteps: "#github-project-steps",
  githubProjectPayload: "#github-project-payload",
  openSettings: "#open-settings",
  filesRoot: "#files-root",
  filesHost: "#files-host",
  filesRefresh: "#files-refresh",
  filesClose: "#files-close",
  filesNewFile: "#files-new-file",
  filesNewFolder: "#files-new-folder",
  filesStatus: "#files-status",
  filesTree: "#files-tree",
  fileEditor: "#file-editor",
  fileEditorPath: "#file-editor-path",
  fileEditorContent: "#file-editor-content",
  fileSave: "#file-save",
  fileRename: "#file-rename",
  fileDelete: "#file-delete",
};

const cache = Object.create(null);

export const els = new Proxy(Object.create(null), {
  get(_target, key) {
    if (typeof key !== "string") return undefined;
    const sel = SELECTORS[key];
    if (!sel) return undefined;
    let node = cache[key];
    if (!node || !node.isConnected) node = cache[key] = document.querySelector(sel);
    return node;
  },
});
