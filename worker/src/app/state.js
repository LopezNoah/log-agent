export const state = {
  sessions: [],
  activeId: null,
  model: null, // "provider/modelID" from settings; sent with each message when set
  agent: null, // selected primary agent ("build" | "plan" | …); sent with each message
  autoApprove: localStorage.getItem("oc.autoApprove") !== "0", // default on
  machineOn: false, // whether the Fly box is started (chat is live only when true)
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
  },
};
