import { escapeHtml } from "./utils.js";

export function setupMarkdown() {
  if (!window.marked) return;
  window.marked.setOptions({ gfm: true, breaks: true });
  if (window.markedKatex) {
    window.marked.use(window.markedKatex({ throwOnError: false, nonStandard: true }));
  }
}

export function renderMarkdown(text) {
  if (!window.marked) return `<div class="text">${escapeHtml(text)}</div>`;
  let html = window.marked.parse(text || "");
  if (window.DOMPurify) {
    html = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
  }
  return `<div class="md">${html}</div>`;
}
