(function () {
"use strict";
const api = window.AiPhone || window.AiPhoneApp;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pad2 = n => String(n).padStart(2, "0");
/** 金额：最多一位小数，去掉多余的 .0 */
const yuan = n => "¥" + (Math.round((Number(n) || 0) * 10) / 10).toString();
const hhmm = t => { const d = new Date(t); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
/** 今天只写时刻，隔天带日期，给聊天历史和订单列表用 */
function when(t, now) {
  const d = new Date(t), n = new Date(now ?? Date.now());
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? hhmm(t) : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(t)}`;
}
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const state = {
  ready: false, background: false,
  settings: null, settingsId: "",
  characters: [], names: {},          // names[charId] = { charName, userName }
  aiShops: [], orders: [], coupons: [],
  wallet: null,
  view: "home", stack: [],            // stack 里放 { view, params }
  params: {},
  recipient: "",                      // "" = 自己，否则角色 id
  category: "全部", query: "",
  sort: "all", onlyLiked: false, onlyOff: false, onlyBought: false,   // 首页店铺列表的排序和筛选
  mode: "delivery",                   // delivery 外卖配送 / pickup 到店自取
  orderManage: false, orderPicked: [], // 订单页「管理」：批量删除时选中的订单 id
  orderTab: "all",                                 // 订单页的分类标签
  cart: { shopId: "", items: {}, base: {} }, // items[行名] = 份数；带规格的行名是「菜名·规格」，base[行名] = 菜名
  busy: "",                           // 正在进行的长操作说明，空 = 空闲
  craving: null,                      // { charId, word, line }
};

let toastTimer = 0;
function toast(text, ms = 2400) {
  const node = $("toast"); if (!node) return;
  node.textContent = text; node.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), ms);
}
function fail(error, prefix) {
  const msg = error && error.message ? error.message : String(error);
  toast((prefix ? prefix + "：" : "") + msg, 3600);
  console.warn("[外卖]", error);
}

/** 底部抽屉：build(box) 往里填内容；关闭时调 onClose */
let sheetOnClose = null;
function openSheet(title, html, onClose) {
  $("sheet-title").textContent = title || "";
  $("sheet-body").innerHTML = html;
  sheetOnClose = onClose || null;
  $("app").classList.add("sheet-open");
  $("sheet").scrollTop = 0;
}
function closeSheet() {
  if (!$("app").classList.contains("sheet-open")) return;
  $("app").classList.remove("sheet-open");
  const cb = sheetOnClose; sheetOnClose = null;
  if (cb) cb();
}

function confirmBox(title, message) {
  if (api && api.ui && api.ui.confirm) return api.ui.confirm({ title, message }).then(r => r === true || (r && r.confirmed === true) || (r && r.ok === true)).catch(() => window.confirm(`${title}\n${message || ""}`));
  return Promise.resolve(window.confirm(`${title}\n${message || ""}`));
}

/** 视图切换：tab 视图清栈，其余压栈，返回键出栈 */
const TAB_VIEWS = ["home", "orders", "me"];
const views = {};          // views[name] = { render(params) -> html, after?(params), title }
function go(view, params) {
  if (TAB_VIEWS.includes(view)) state.stack = [];
  else state.stack.push({ view: state.view, params: state.params });
  state.view = view; state.params = params || {};
  render(true);
}
function back() {
  const prev = state.stack.pop();
  state.view = prev ? prev.view : "home"; state.params = prev ? prev.params : {};
  render(true);
}
function render(resetScroll) {
  const main = $("main"); if (!main || !state.ready) return;
  const v = views[state.view] || views.home;
  const top = resetScroll ? 0 : main.scrollTop;
  main.innerHTML = v.render(state.params);
  main.scrollTop = top;
  const app = $("app"), tone = typeof v.tone === "function" ? v.tone(state.params) : v.tone;
  app.dataset.view = state.view;
  // 顶栏和页面头图的颜色：brand 品牌橙 / hue 店铺主色 / ok 送达绿 / plain 素色
  app.dataset.tone = (tone && tone.name) || tone || "plain";
  app.style.setProperty("--hue", (tone && tone.hue) || "var(--brand)");
  $("title").textContent = typeof v.title === "function" ? v.title(state.params) : v.title;
  $("btn-back").hidden = TAB_VIEWS.includes(state.view);
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === state.view));
  $("tabs").hidden = !TAB_VIEWS.includes(state.view);
  renderCartBar();
  if (v.after) v.after(state.params);
}

/** 事件委托：元素上写 data-act="名字"，actions[名字](dataset, 元素, 事件) */
const actions = {};
function bindActions() {
  document.addEventListener("click", ev => {
    const node = ev.target.closest("[data-act]");
    if (!node || node.disabled) return;
    const fn = actions[node.dataset.act];
    if (!fn) return;
    ev.preventDefault();
    Promise.resolve().then(() => fn(node.dataset, node, ev)).catch(fail);
  });
  document.addEventListener("change", ev => {
    const node = ev.target.closest("[data-change]");
    if (!node) return;
    const fn = actions[node.dataset.change];
    if (fn) Promise.resolve().then(() => fn(node.dataset, node, ev)).catch(fail);
  });
}

/** 长操作：期间显示说明并挡住重复点击 */
async function busy(label, work) {
  if (state.busy) { toast("上一个操作还没结束"); return undefined; }
  state.busy = label; $("busy").textContent = label; $("app").classList.add("is-busy");
  try { return await work(); }
  finally { state.busy = ""; $("app").classList.remove("is-busy"); }
}
