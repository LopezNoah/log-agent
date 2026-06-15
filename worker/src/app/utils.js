export function stringify(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
