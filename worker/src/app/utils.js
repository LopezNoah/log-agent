export function stringify(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Corner toast. Stacks in a fixed container (bottom-right) and auto-dismisses. `type` is "info" or
// "error"; when omitted it's inferred from the text so the many "X failed: …" call sites surface
// as red error toasts without each having to pass a type.
export function toast(msg, type) {
  const text = String(msg);
  const kind = type || (/\b(fail|failed|error|unavailable|timed out|could ?n'?t|couldn't)\b/i.test(text) ? "error" : "info");

  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }

  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " error" : "");
  t.textContent = text;
  stack.appendChild(t);

  setTimeout(() => {
    t.classList.add("toast-out");
    setTimeout(() => t.remove(), 200);
  }, 4200);
}

// Anchored confirmation popover — replaces native confirm() for destructive actions. Pops a small
// styled card next to the button that triggered it (flips above when there's no room below) and
// resolves true on confirm, false on Cancel / Escape / click-outside. Only one is open at a time.
// Pass anchor=null for a centered, caret-less card.
let closeOpenConfirm = null;

export function confirmAction(anchor, opts = {}) {
  const { title = "Are you sure?", body = "", confirmLabel = "Delete", cancelLabel = "Cancel", danger = true } = opts;
  closeOpenConfirm?.(); // dismiss any popover already on screen (resolves it false)

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const pop = document.createElement("div");
    pop.className = "confirm-pop";
    pop.setAttribute("role", "alertdialog");
    pop.setAttribute("aria-label", title);
    pop.innerHTML =
      `${anchor ? '<div class="confirm-caret"></div>' : ""}` +
      `<div class="confirm-title">${escapeHtml(title)}</div>` +
      (body ? `<div class="confirm-body">${escapeHtml(body)}</div>` : "") +
      `<div class="confirm-actions">` +
        `<button type="button" class="btn btn-ghost confirm-cancel">${escapeHtml(cancelLabel)}</button>` +
        `<button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"} confirm-ok">${escapeHtml(confirmLabel)}</button>` +
      `</div>`;
    overlay.appendChild(pop);
    document.body.appendChild(overlay);

    // Position relative to the trigger (measured after insertion so offsetWidth/Height are real).
    const margin = 8;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      let top = r.bottom + margin, above = false;
      if (top + ph > vh - margin && r.top - margin - ph > 0) { top = r.top - margin - ph; above = true; }
      let left = Math.max(margin, Math.min(r.left + r.width / 2 - pw / 2, vw - pw - margin));
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
      pop.classList.toggle("above", above);
      const caret = pop.querySelector(".confirm-caret");
      caret.style.left = `${Math.max(14, Math.min(r.left + r.width / 2 - left, pw - 14))}px`;
    } else {
      pop.style.top = `${Math.max(margin, (vh - ph) / 2)}px`;
      pop.style.left = `${Math.max(margin, (vw - pw) / 2)}px`;
    }

    requestAnimationFrame(() => pop.classList.add("in"));

    function done(result) {
      if (closeOpenConfirm !== close) return; // already resolved
      closeOpenConfirm = null;
      document.removeEventListener("keydown", onKey, true);
      pop.classList.remove("in");
      pop.classList.add("out");
      setTimeout(() => overlay.remove(), 130);
      resolve(result);
    }
    const close = () => done(false);
    closeOpenConfirm = close;

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); done(true); }
    }
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(false); });
    pop.querySelector(".confirm-cancel").addEventListener("click", () => done(false));
    pop.querySelector(".confirm-ok").addEventListener("click", () => done(true));
    pop.querySelector(".confirm-ok").focus();
  });
}
