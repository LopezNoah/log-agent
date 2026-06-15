import { els } from "./dom.js";

function openSidebar() {
  els.sidebar.classList.add("open");
  els.scrim.hidden = false;
}

export function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.scrim.hidden = true;
}

function openFilesPane() {
  els.filesPane.classList.add("open");
  els.scrim.hidden = false;
}

function closeFilesPane() {
  els.filesPane.classList.remove("open");
  els.scrim.hidden = true;
}

export function setupMobile() {
  els.menuToggle.addEventListener("click", () =>
    els.sidebar.classList.contains("open") ? closeSidebar() : openSidebar());
  els.filesToggle.addEventListener("click", () =>
    els.filesPane.classList.contains("open") ? closeFilesPane() : openFilesPane());
  els.filesClose.addEventListener("click", closeFilesPane);
  els.scrim.addEventListener("click", () => { closeSidebar(); closeFilesPane(); });
}
