(function () {
"use strict";
const api = window.AiPhone;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 尾随节流：窗口内只留最后一次；cancel 后待发的一次作废 */
function throttle(fn, ms) {
  let timer = 0, last;
  const run = v => { last = v; if (timer) return; timer = setTimeout(() => { timer = 0; fn(last); }, ms); };
  run.cancel = () => { if (timer) clearTimeout(timer); timer = 0; };
  return run;
}
const uid = p => `${p || "x"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const clone = v => JSON.parse(JSON.stringify(v));
const state = {
  settings: null, characters: [], character: null, userName: "用户",
  combos: [], prompts: [], randoms: [], macros: [], preambles: [], favorites: [], recents: [],
  view: "stage", libTab: "combo", currentComboId: "", busy: false, result: null, compose: null,
};

let toastTimer = 0;
function toast(text, ms = 2200) {
  const node = $("toast"); node.textContent = text; node.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), ms);
  if (api && api.ui && api.ui.toast) api.ui.toast(text).catch?.(() => {});
}
function fail(error) { const msg = error && error.message ? error.message : String(error); toast(msg, 3400); console.warn("[小剧场]", error); }

let sheetOnClose = null;
function openSheet(title, build, onClose) {
  const box = $("sheet-content"); box.innerHTML = "";
  $("sheet-title").textContent = title || "";
  sheetOnClose = onClose || null;
  build(box);
  $("app").classList.add("sheet-open");
  $("sheet").scrollTop = 0;
}
function closeSheet() {
  $("app").classList.remove("sheet-open");
  const fn = sheetOnClose; sheetOnClose = null; if (fn) fn();
  setTimeout(() => { if (!$("app").classList.contains("sheet-open")) $("sheet-content").innerHTML = ""; }, 300);
}
$("sheet-mask").onclick = closeSheet; $("sheet-close").onclick = closeSheet;

function confirmSheet(title, text, okLabel, onOk, danger) {
  openSheet(title, box => {
    box.appendChild(el("p", "note-box", text));
    const btns = el("div", "btns");
    const cancel = el("button", "", "取消"); cancel.type = "button"; cancel.onclick = closeSheet;
    const ok = el("button", danger ? "warn" : "pri", okLabel || "确定"); ok.type = "button";
    ok.onclick = () => { closeSheet(); Promise.resolve().then(onOk).catch(fail); };
    btns.append(cancel, ok); box.appendChild(btns);
  });
}

const viewHooks = {};
function switchView(name, arg) {
  state.view = name;
  $("app").dataset.view = name;
  document.querySelectorAll("#tabbar [data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === (name === "compose" ? "library" : name)));
  $("main").scrollTop = 0;
  if (viewHooks[name]) viewHooks[name](arg);
}
document.querySelectorAll("#tabbar [data-v]").forEach(b => { b.onclick = () => switchView(b.dataset.v); });

const pad2 = n => String(n).padStart(2, "0");
const fmtTime = iso => { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ""; const now = new Date(); const same = d.toDateString() === now.toDateString(); const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; if (same) return hm; const y = new Date(now); y.setDate(y.getDate() - 1); if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`; return `${d.getMonth() + 1}-${d.getDate()} ${hm}`; };
const fmtFull = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const splitTags = s => String(s || "").split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i);
const byId = (list, id) => list.find(x => x.id === id) || null;
const charName = c => (c && c.name) || "角色";

/** 标签输入：chips + 输入框，回车/逗号加标签，点 chip 删 */
function tagInput(initial, onChange) {
  const wrap = el("div", "tagin inp");
  let tags = [...(initial || [])];
  const input = el("input"); input.placeholder = tags.length ? "" : "输入后回车添加标签";
  const render = () => {
    wrap.querySelectorAll(".chip").forEach(c => c.remove());
    tags.forEach(t => { const c = el("span", "chip x", t); c.onclick = () => { tags = tags.filter(x => x !== t); render(); onChange(tags); }; wrap.insertBefore(c, input); });
  };
  const commit = () => { const add = splitTags(input.value); if (!add.length) return; tags = [...new Set([...tags, ...add])]; input.value = ""; render(); onChange(tags); };
  input.onkeydown = e => { if (e.key === "Enter" || e.key === "," || e.key === "，") { e.preventDefault(); commit(); } else if (e.key === "Backspace" && !input.value && tags.length) { tags.pop(); render(); onChange(tags); } };
  input.onblur = commit;
  wrap.appendChild(input); render();
  return wrap;
}

/** 单选段：options=[{v,l}] */
function miniSeg(options, value, onChange) {
  const box = el("div", "mini");
  const paint = v => box.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
  options.forEach(o => { const b = el("button", "", o.l); b.type = "button"; b.dataset.v = String(o.v); b.onclick = () => { paint(o.v); onChange(o.v); }; box.appendChild(b); });
  paint(value);
  return box;
}
function toggle(value, onChange) {
  const t = el("div", "tog" + (value ? " on" : "")); t.setAttribute("role", "switch");
  t.onclick = () => { const on = !t.classList.contains("on"); t.classList.toggle("on", on); onChange(on); };
  return t;
}
function setRow(label, sub, control) {
  const row = el("div", "set"); const l = el("div", "l"); l.appendChild(el("b", "", label)); if (sub) l.appendChild(el("span", "", sub));
  row.append(l, control); return row;
}
function stepper(value, min, max, onChange) {
  const box = el("div", "stepper"); let v = value;
  const minus = el("button", "", "−"); minus.type = "button"; const num = el("span", "", String(v)); const plus = el("button", "", "+"); plus.type = "button";
  const set = n => { v = Math.max(min, Math.min(max, n)); num.textContent = String(v); onChange(v); };
  minus.onclick = () => set(v - 1); plus.onclick = () => set(v + 1);
  box.append(minus, num, plus); return box;
}
