(function () {
"use strict";
const api = window.AiPhone;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = {
  settings: null, characters: [], character: null, nights: [], mixes: [], library: [],
  mode: "lull", timerMin: 45, view: "home", session: null, voiceReady: null,
};
const bus = new EventTarget();
const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
const on = (name, fn) => bus.addEventListener(name, e => fn(e.detail));

let toastTimer = 0;
function toast(text, ms = 2200) {
  const node = $("toast"); node.textContent = text; node.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), ms);
}
function fail(error) { const msg = error && error.message ? error.message : String(error); toast(msg, 3200); console.warn("[陪眠]", error); }

let sheetOnClose = null;
function openSheet(title, build, onClose) {
  const box = $("sheet-content"); box.innerHTML = "";
  $("sheet-title").textContent = title || "";
  sheetOnClose = onClose || null;
  build(box);
  $("app").classList.add("sheet-open");
  $("sheet").scrollTop = 0;
}
function closeSheet() { $("app").classList.remove("sheet-open"); const fn = sheetOnClose; sheetOnClose = null; if (fn) fn(); setTimeout(() => { if (!$("app").classList.contains("sheet-open")) $("sheet-content").innerHTML = ""; }, 300); }
$("sheet-mask").onclick = closeSheet; $("sheet-close").onclick = closeSheet;

function switchView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.dataset.view === name));
  document.querySelectorAll("#tabbar .tb").forEach(b => b.classList.toggle("on", b.dataset.view === name));
  window.scrollTo(0, 0);
  emit("view", name);
}
document.querySelectorAll("#tabbar .tb").forEach(b => { b.onclick = () => switchView(b.dataset.view); });

const fmtClock = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const moonsHtml = n => n ? `<span class="moons">${iconSvg("moon").repeat(n)}</span>` : "";
