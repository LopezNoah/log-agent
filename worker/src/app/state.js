export const state = {
  sessions: [],
  activeId: null,
  model: null, // "provider/modelID" from settings; sent with each message when set
  agent: null, // selected primary agent ("build" | "plan" | …); sent with each message
  agents: [], // [{name,label}] primary agents for the composer's agent picker
  // Which "brain" handles a send: "opencode" (the box, default) or "worker" (the Worker-side
  // /api/agent/chat agent). Opt-in: defaults to "opencode" so nothing changes unless toggled.
  brain: localStorage.getItem("oc.brain") === "worker" ? "worker" : "opencode",
  autoApprove: localStorage.getItem("oc.autoApprove") !== "0", // default on
  machineOn: false, // whether the Fly box is started (chat is live only when true)
  busy: new Set(), // sessionIDs currently generating a response (drives Stop vs Send)
  messages: new Map(), // messageID -> { info, parts: Map<partID, part>, order: [] }
  ws: null, // /sync WebSocket to the SyncHub DO
  files: {
    root: null,
    nodes: new Map(),
    expanded: new Set([""]),
    selected: "",
    selectedType: "directory",
    selectedMtime: "",
    loading: false,
    dirty: false,
    editorOpen: false,
  },
};
