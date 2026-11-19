#!/usr/bin/env node
// 外卖 APP 主流程：给 index.html 套一个内存版 AiPhone，在无头 Chromium 里把点餐、配送、和聊天的联动走一遍。
// 用法：node scripts/check-wai-mai-browser.mjs [--shots <目录>] [--emoji-font <字体文件>]
// 带 --shots 时顺便把各页面截图存下来；这台机器没有彩色表情字体，截图前用 --emoji-font 临时挂一个，不然食物图标是方框。
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const APP = path.join(ROOT, "custom-apps/wai-mai");
const shotIndex = process.argv.indexOf("--shots");
const SHOTS = shotIndex > 0 ? path.resolve(process.argv[shotIndex + 1]) : "";
if (SHOTS) await fsp.mkdir(SHOTS, { recursive: true });
const fontIndex = process.argv.indexOf("--emoji-font");
const EMOJI_FONT = fontIndex > 0 ? path.resolve(process.argv[fontIndex + 1]) : "";
const OUT = await fsp.mkdtemp("/tmp/wm-browser-check-");
const PREVIEW = path.join(OUT, "preview.html");

const avatar = (ch, a, b) => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#fff" font-family="serif">${ch}</text></svg>`);
const AI_SHOPS = { shops: [
  { name: "椒麻巷 · 现煮麻辣烫", category: "烧烤小吃", tagline: "骨汤打底，辣度自己选", rating: 4.7, minOrder: 18, fee: 3, off: [40, 5], dishes: [
    { name: "招牌麻辣烫（荤素自选）", price: 26, desc: "八样菜起，汤底可选骨汤", tag: "招牌" }, { name: "番茄牛腩麻辣烫", price: 32, desc: "不辣也好吃", tag: "" },
    { name: "手打虾滑", price: 12, desc: "加进任意一碗", tag: "" }, { name: "宽粉", price: 4, desc: "", tag: "" }, { name: "冰粉", price: 8, desc: "红糖桂花", tag: "" }, { name: "酸梅汤", price: 6, desc: "", tag: "" }] },
  { name: "老陈记麻辣烫", category: "烧烤小吃", tagline: "开了十九年的街坊老店", rating: 4.5, minOrder: 15, fee: 2, dishes: [
    { name: "经典麻辣烫", price: 19, desc: "老味道，芝麻酱很足", tag: "招牌" }, { name: "麻辣拌", price: 20, desc: "干拌，甜口", tag: "" }, { name: "炸腐竹", price: 6, desc: "", tag: "" }, { name: "烧饼", price: 3, desc: "", tag: "" }] },
] };

const mock = `<script>
window.AiPhone = (() => {
  const tables = {}; let n = 100, mid = 0;
  const chars = [{ id: "c1", name: "沈烬言", avatar: ${JSON.stringify(avatar("沈", "#4a3f8f", "#8d7bff"))} }, { id: "c2", name: "宁妍", avatar: ${JSON.stringify(avatar("宁", "#8f3f5f", "#ff7bb0"))} }];
  const wallet = { defaultAccountId: "balance", accounts: [{ id: "balance", type: "balance", title: "余额", balance: 200, balanceLabel: "¥200.00" }, { id: "card1", type: "card", title: "储蓄卡", balance: 5, balanceLabel: "¥5.00" }] };
  const log = window.__log = { cards: [], cardUpdates: [], history: [], replies: [], context: {}, tasks: {}, canceled: [], notices: [], pays: [], ai: [] };
  const handlers = window.__handlers = { events: {}, provider: null };
  const rows = t => (tables[t] ||= []);
  return { __mock: true,
    on: (name, fn) => { (handlers.events[name] ||= []).push(fn); return () => {}; },
    app: { getLaunchContext: async () => window.__launch || null, close: async () => {} },
    db: {
      list: async (t, q = {}) => rows(t).slice(q.offset || 0, (q.offset || 0) + (q.limit || 100)).map(r => JSON.parse(JSON.stringify(r))),
      get: async (t, id) => rows(t).find(r => r.id === id) || null,
      create: async (t, d) => { const row = { ...JSON.parse(JSON.stringify(d)), id: "x" + (++n) }; rows(t).push(row); return { ...row }; },
      update: async (t, id, d) => { const row = rows(t).find(r => r.id === id); if (!row) throw new Error("no row " + id); Object.assign(row, JSON.parse(JSON.stringify(d))); return { ...row }; },
      delete: async (t, id) => { tables[t] = rows(t).filter(r => r.id !== id); return { ok: true }; } },
    characters: { list: async () => chars.map(c => ({ ...c })), get: async id => chars.find(c => c.id === id) || null },
    user: { getProfile: async () => ({ name: "阿栀" }) },
    wallet: { get: async () => JSON.parse(JSON.stringify(wallet)),
      pay: async p => { const a = wallet.accounts.find(x => x.id === (p.accountId || "balance")); log.pays.push(p); if (!a || a.balance < p.amount) return { ok: false, error: "余额不足" }; a.balance = Math.round((a.balance - p.amount) * 100) / 100; a.balanceLabel = "¥" + a.balance.toFixed(2); return { ok: true }; } },
    ai: {
      chat: async p => { log.ai.push({ kind: "chat", ...p }); await new Promise(r => setTimeout(r, 120)); return { text: "好的，下面是店铺：\\n\`\`\`json\\n" + ${JSON.stringify(JSON.stringify(AI_SHOPS))} + "\\n\`\`\`" }; },
      generate: async p => { log.ai.push({ kind: "generate", ...p }); await new Promise(r => setTimeout(r, 120)); return { text: "[想吃:奶茶:随便……要不你挑个不太甜的。]" }; } },
    chat: {
      sendCard: async p => { const r = { messageId: "m" + (++mid), sessionId: "s_" + p.characterId }; log.cards.push({ ...p, ...r }); return r; },
      updateCard: async p => { log.cardUpdates.push(p); return { ok: true }; },
      writeHistory: async p => { log.history.push(p); return { ok: true }; },
      requestReply: async p => { log.replies.push(p); return { ok: true }; },
      setContext: async p => { log.context[p.characterId] = p.text; return { ok: true }; },
      clearContext: async () => ({ ok: true }),
      openConversation: async () => ({ ok: true }),
      registerContextProvider: async fn => { handlers.provider = fn; return { ok: true }; } },
    tasks: { schedule: async p => { log.tasks[p.id] = p; return p; }, cancel: async id => { log.canceled.push(id); delete log.tasks[id]; return true; } },
    notifications: { create: async p => { log.notices.push(p); return { ok: true }; }, clearBadge: async () => ({ ok: true }) },
    ui: { toast: async () => {}, confirm: async () => true },
  };
})();
</script>`;
const fontCss = EMOJI_FONT ? `<style>@font-face{font-family:"Noto Color Emoji";src:url("file://${EMOJI_FONT}");unicode-range:U+200D,U+20E3,U+2190-21FF,U+2300-23FF,U+2600-27BF,U+2B00-2BFF,U+FE0F,U+1F000-1FAFF}</style>` : "";
const html = (await fsp.readFile(path.join(APP, "index.html"), "utf8")).replace("<script>", fontCss + mock + "<script>");
await fsp.writeFile(PREVIEW, html);

const profile = await fsp.mkdtemp("/tmp/shot-wm-");
const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--hide-scrollbars", "--allow-file-access-from-files", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });
process.on("uncaughtException", e => { console.error(e); process.exit(1); });
process.on("unhandledRejection", e => { console.error(e); process.exit(1); });
let port;
for (let i = 0; i < 100; i++) { try { port = Number((await fsp.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const socket = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
const pending = new Map(); let serial = 0; const logs = [];
socket.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) logs.push(m.params.type + " " + m.params.args.map(a => a.value ?? a.description).join(" "));
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "")); return r.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tap = sel => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no '+${JSON.stringify(sel)}); e.click(); return true;})()`);
const waitFor = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const idle = () => waitFor(`!window.__wm.state.busy`);
const shot = async name => { if (!SHOTS) return; await evaluate(`(()=>{document.querySelector('#toast').classList.remove('show'); return true})()`); await sleep(350); const r = await send("Page.captureScreenshot", { format: "png" }); await fsp.writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64")); };
const scrollMain = y => evaluate(`(()=>{document.querySelector('#main').scrollTop=${y}; return true})()`);
const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
const fill = (sel, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
/** 把一张订单整体往前挪，相当于时间过去了这么久 */
const rewind = (index, ms) => evaluate(`(()=>{const o=window.__wm.state.orders[${index}]; o.timeline=o.timeline.map(e=>({...e,at:e.at-${ms}})); o.deliverAt-=${ms}; window.__wm.render(); return true;})()`);
/** 加一份；有规格的菜会先弹出选规格，按默认规格加 */
const add = async name => {
  await tap(`[data-act="cart-inc"]${name ? `[data-name="${name}"]` : ""}`); await sleep(60);
  if (await evaluate(`document.querySelector('#app').classList.contains('sheet-open') && !!document.querySelector('#sheet [data-act="spec-add"]')`)) { await tap(`[data-act="spec-add"]`); await sleep(80); }
};
const shopCount = () => evaluate(`document.querySelectorAll('.shop').length`);
const emit = payload => evaluate(`Promise.all(window.__handlers.events['chat.message.created'].map(fn=>fn(${JSON.stringify(payload)}))).then(()=>true)`);

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.navigate", { url: "file://" + PREVIEW });
await waitFor(`!!window.__wm && window.__wm.state.ready`);

try {
  // 1. 首页：内置 10 家店；排序、筛选、分类
  assert.equal(await shopCount(), 10);
  await shot("01-home");
  await scrollMain(470); await shot("01b-home-shops"); await scrollMain(0);
  await tap(`[data-act="set-sort"][data-sort="rating"]`);
  const ratings = await evaluate(`[...document.querySelectorAll('.shop')].map(e => window.__wm.shopById(e.dataset.id).rating)`);
  assert.deepEqual(ratings, ratings.slice().sort((a, b) => b - a), "按评分从高到低");
  await tap(`[data-act="set-sort"][data-sort="all"]`);
  await tap(`[data-act="toggle-filter"][data-key="onlyOff"]`);
  assert.ok(await evaluate(`[...document.querySelectorAll('.shop')].every(e => window.__wm.shopById(e.dataset.id).off)`), "只看有满减的店");
  await tap(`[data-act="toggle-filter"][data-key="onlyOff"]`);
  await tap(`[data-act="set-category"][data-c="买药"]`);
  assert.equal(await shopCount(), 1);
  await tap(`[data-act="set-category"][data-c="买药"]`);
  assert.equal(await shopCount(), 10, "再点一次回到全部");

  // 2. 进店、加购
  await tap(`[data-act="open-shop"][data-id="seed_noodle"]`);
  await tap(`[data-act="cart-inc"][data-name="红烧牛肉面"]`); await sleep(80);
  await tap(`[data-act="spec-pick"][data-g="0"][data-i="1"]`);
  await shot("02c-spec");
  await tap(`[data-act="spec-add"]`); await sleep(80);
  await add("卤蛋"); await add("卤蛋");
  assert.match(await text("#cartbar"), /¥30/);
  assert.deepEqual(await evaluate(`window.__wm.state.cart.items`), { "红烧牛肉面·微辣": 1, "卤蛋": 2 });
  await shot("02-shop");
  // 购物车抽屉里能加减；收藏；评价和商家两个标签页
  await tap(`[data-act="open-cart"]`); await sleep(80);
  await shot("02d-cart");
  await tap(`#sheet [data-act="cart-line"][data-d="1"]`); await sleep(60);
  assert.equal(await evaluate(`window.__wm.state.cart.items["红烧牛肉面·微辣"]`), 2);
  await tap(`#sheet [data-act="cart-line"][data-d="-1"]`); await sleep(60);
  assert.equal(await evaluate(`window.__wm.state.cart.items["红烧牛肉面·微辣"]`), 1);
  await tap(`#sheet-close`);
  await tap(`[data-act="toggle-like"]`); await sleep(120);
  assert.deepEqual(await evaluate(`window.__wm.state.settings.likedShops`), ["seed_noodle"]);
  await tap(`[data-act="shop-tab"][data-tab="info"]`);
  await shot("02b-shop-info");
  assert.equal(await evaluate(`document.querySelector('#cartbar').hidden`), true, "不在点菜页时收起购物车条");
  await tap(`[data-act="shop-tab"][data-tab="menu"]`);

  // 3. 结算、钱包付款
  await tap(`[data-act="to-checkout"]`);
  await waitFor(`window.__wm.state.view === 'checkout'`);
  await fill(`[data-key="note"]`, "少辣，不要香菜");
  await shot("03-checkout");
  await tap(`[data-act="place-order"]`); await idle();
  await waitFor(`window.__wm.state.view === 'order'`);
  let o = await evaluate(`window.__wm.state.orders[0]`);
  assert.equal(o.total, 32.5); assert.equal(o.status, "active"); assert.equal(o.note, "少辣，不要香菜");
  assert.equal(await evaluate(`window.__log.pays[0].amount`), 32.5);
  assert.ok(await evaluate(`!!window.__log.tasks['wm_arrive_${o.id}']`), "送达任务已挂上");
  assert.equal(await evaluate(`window.__log.tasks['wm_arrive_${o.id}'].actions.length`), 1, "给自己点的只有一条通知");
  assert.equal(await evaluate(`window.__log.cards.length`), 0);
  await rewind(0, Math.round((o.deliverAt - Date.now()) * 0.55));
  await shot("04-order-live");
  await scrollMain(400); await shot("04b-order-live-detail"); await scrollMain(0);

  // 催单、换速度都会重挂送达任务
  await tap(`[data-act="order-urge"]`); await sleep(150);
  assert.equal(await evaluate(`window.__wm.state.orders[0].urged`), true);
  await tap(`[data-act="order-speed"][data-speed="real"]`); await sleep(150);
  assert.equal(await evaluate(`window.__wm.state.orders[0].speed`), "real");
  assert.ok(await evaluate(`window.__log.tasks['wm_arrive_${o.id}'].delayMs > 5 * 60000`));

  // 送到之后：评价
  await rewind(0, 3 * 3600000);
  assert.match(await text(".status h2"), /已送达/);
  await tap(`[data-act="order-rate"][data-stars="4"]`);
  await fill("#review-text", "汤头很好");
  await tap(`[data-act="order-rate-save"]`); await sleep(150);
  assert.equal(await evaluate(`window.__wm.state.orders[0].review.stars`), 4);
  await shot("05-order-done");
  await scrollMain(300); await shot("05b-order-receipt"); await scrollMain(0);

  // 4. 给角色点：问 TA 想吃什么 → 下单 → 聊天卡片 + 送达任务
  await tap(`#tabs [data-tab="home"]`);
  await tap(`[data-act="pick-recipient"]`);
  await shot("06-recipient");
  await tap(`[data-act="set-recipient"][data-id="c1"]`);
  await tap(`[data-act="ask-crave"]`); await idle();
  assert.match(await text(".crave-line"), /不太甜/);
  await shot("07-crave");
  await tap(`.crave [data-act="search-word"]`);
  assert.ok(await evaluate(`document.querySelectorAll('.shop').length >= 1`));
  await tap(`[data-act="open-shop"][data-id="seed_tea"]`);
  await add("茉莉奶绿");
  await tap(`[data-act="to-checkout"]`); await waitFor(`window.__wm.state.view === 'checkout'`);
  assert.equal(await evaluate(`!!document.querySelector('[data-key="payMode"][data-value="char"]')`), false, "送给角色时没有代付选项");
  await tap(`[data-act="place-order"]`); await idle();
  o = await evaluate(`window.__wm.state.orders[0]`);
  assert.equal(o.recipient, "c1"); assert.equal(o.cardMessageId, "m1");
  const card = await evaluate(`window.__log.cards[0]`);
  assert.equal(card.characterId, "c1"); assert.match(card.historyText, /阿栀给沈烬言点了「半糖茶铺」的外卖：茉莉奶绿/);
  const gift = await evaluate(`window.__log.tasks['wm_arrive_${o.id}'].actions.map(a => a.type)`);
  assert.deepEqual(gift, ["notification", "chat.updateCard", "chat.history", "chat.setContext", "chat.reply"]);
  assert.match(await evaluate(`window.__log.tasks['wm_arrive_${o.id}'].actions[2].content`), /已在 \d\d:\d\d 送到沈烬言手上/);

  // 5. 聊天上下文：TA 那份外卖还没到；别的角色什么都看不到
  const ctx1 = await evaluate(`window.__handlers.provider({ characterId: 'c1' })`);
  assert.match(ctx1, /阿栀给你点的「半糖茶铺」的外卖（茉莉奶绿[^）]*）还没送到/); assert.match(ctx1, /送到之前你还没拿到/);
  assert.equal(await evaluate(`window.__handlers.provider({ characterId: 'c2' })`), "");
  assert.match(await evaluate(`window.__log.context.c1`), /预计 \d\d:\d\d 送到，在那之前都还在路上/);
  await rewind(0, 3600000);
  assert.match(await evaluate(`window.__handlers.provider({ characterId: 'c1' })`), /已在 \d\d:\d\d 送到你手上/);

  // 6. 角色主动给我点：收到卡片消息就建单、开始配送、把卡片改成配送中
  await emit({ characterId: "c2", sessionId: "s_c2", isGroup: false, message: { id: "m90", role: "assistant", mediaType: "app_card", mediaData: { appDirectiveId: "wm-order", appDirectiveArgs: ["巷尾面馆", "葱油拌面、卤蛋×2", "趁热吃"] } } });
  o = await evaluate(`window.__wm.state.orders[0]`);
  assert.equal(o.source, "directive"); assert.equal(o.payer, "char"); assert.equal(o.status, "active"); assert.equal(o.note, "趁热吃");
  assert.deepEqual(o.items, [{ name: "葱油拌面", qty: 1, price: 12 }, { name: "卤蛋", qty: 2, price: 3 }]);
  assert.equal(await evaluate(`window.__log.cardUpdates.at(-1).messageId`), "m90");
  assert.equal(await evaluate(`window.__log.cardUpdates.at(-1).status`), "配送中");
  await emit({ characterId: "c2", sessionId: "s_c2", isGroup: false, message: { id: "m90", role: "assistant", mediaType: "app_card", mediaData: { appDirectiveId: "wm-order", appDirectiveArgs: ["巷尾面馆", "葱油拌面", "无"] } } });
  assert.equal(await evaluate(`window.__wm.state.orders.filter(x => x.directiveMessageId === 'm90').length`), 1, "同一条消息不会建两张单");
  assert.match(await evaluate(`window.__handlers.provider({ characterId: 'c2' })`), /你给阿栀点的「巷尾面馆」的外卖.*还没送到.*别问好不好吃/s);
  await tap(`#tabs [data-tab="orders"]`);
  await shot("08-orders");
  await tap(`[data-act="order-tab"][data-tab="live"]`);
  assert.ok(await evaluate(`document.querySelectorAll('.order').length`) >= 1);
  assert.equal(await evaluate(`document.querySelectorAll('.order .st.live').length`), await evaluate(`document.querySelectorAll('.order').length`), "进行中只剩在路上的");
  await tap(`[data-act="order-tab"][data-tab="all"]`);

  // 7. 请角色代付：同意后才开始配送；拒绝后可以改成自己付
  const payFlow = async verdict => {
    await tap(`#tabs [data-tab="home"]`);
    await evaluate(`(()=>{window.__wm.state.recipient=''; window.__wm.state.query=''; window.__wm.render(); return true})()`);
    await tap(`[data-act="open-shop"][data-id="seed_bbq"]`);
    await add("羊肉串（5 串）"); await add("烤馒头片");
    await tap(`[data-act="to-checkout"]`); await waitFor(`window.__wm.state.view === 'checkout'`);
    await tap(`[data-key="payMode"][data-value="char"]`);
    if (verdict === "同意") await shot("09-checkout-payreq");
    const paysBefore = await evaluate(`window.__log.pays.length`);
    await tap(`[data-act="place-order"]`); await idle();
    const order = await evaluate(`window.__wm.state.orders[0]`);
    assert.equal(order.status, "pending_pay"); assert.equal(order.source, "payreq"); assert.equal(order.charId, "c1");
    assert.equal(await evaluate(`window.__log.pays.length`), paysBefore, "代付不扣自己的钱");
    assert.match(await evaluate(`window.__log.cards.at(-1).historyText`), /外卖代付请求：阿栀在「炭火小院」点了.*想请沈烬言帮忙付款/);
    assert.equal(await evaluate(`window.__log.replies.at(-1).characterId`), "c1");
    assert.match(await evaluate(`window.__handlers.provider({ characterId: 'c1' })`), /请你代付/);
    await emit({ characterId: "c1", sessionId: "s_c1", isGroup: false, message: { id: "m" + Math.random(), role: "assistant", mediaType: "app_card", mediaData: { appDirectiveId: "wm-pay", appDirectiveArgs: [verdict, "下不为例"] } } });
    return evaluate(`window.__wm.state.orders[0]`);
  };
  o = await payFlow("同意");
  assert.equal(o.status, "active"); assert.ok(o.deliverAt > Date.now()); assert.equal(o.payWords, "下不为例");
  assert.match(await evaluate(`window.__log.cardUpdates.at(-1).status`), /TA 已代付/);
  await evaluate(`(async()=>{const s=window.__wm.state; const x=s.orders[0]; x.timeline=x.timeline.map(e=>({...e,at:e.at-7200000})); x.deliverAt-=7200000; return true})()`);
  o = await payFlow("拒绝");
  assert.equal(o.status, "pay_declined");
  await shot("10-pay-declined");
  const balance = await evaluate(`window.AiPhone.wallet.get().then(w => w.accounts[0].balance)`);
  await tap(`[data-act="order-pay-self"]`); await idle(); await sleep(150);
  o = await evaluate(`window.__wm.state.orders[0]`);
  assert.equal(o.status, "active"); assert.equal(o.payer, "user");
  assert.equal(await evaluate(`window.AiPhone.wallet.get().then(w => w.accounts[0].balance)`), Math.round((balance - o.total) * 100) / 100);

  // 付了钱再取消：退成红包，送达任务撤掉
  await tap(`[data-act="order-cancel"]`); await sleep(200);
  o = await evaluate(`window.__wm.state.orders[0]`);
  assert.equal(o.status, "canceled");
  assert.ok(await evaluate(`window.__log.canceled.includes('wm_arrive_${o.id}')`));
  assert.equal(await evaluate(`window.__wm.state.coupons.filter(c => !c.used).reduce((s, c) => s + c.amount, 0)`), o.total);

  // 8. AI 找店：本地搜不到 → 让模型编 → 留在首页；下单时红包自动抵扣
  await tap(`#tabs [data-tab="home"]`);
  await evaluate(`(()=>{document.querySelector('#q').value='麻辣烫'; document.querySelector('[data-form="search"]').requestSubmit(); return true})()`);
  await sleep(100);
  assert.equal(await evaluate(`document.querySelectorAll('.shop').length`), 0);
  await shot("11-search-empty");
  await tap(`[data-act="ai-shops"]`); await idle();
  assert.equal(await evaluate(`window.__wm.state.aiShops.length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll('.shop .tag.ai').length`), 2);
  await shot("12-ai-shops");
  await tap(`.shop`);
  await add("");
  await tap(`[data-act="to-checkout"]`); await waitFor(`window.__wm.state.view === 'checkout'`);
  assert.match(await text(".line.total"), /¥0/, "红包够抵时合计为 0");
  // 送给谁在结算页选：换成角色后地址跟着换，也不能再找 TA 代付
  await tap(`.whos [data-act="set-recipient"][data-id="c2"]`);
  assert.equal(await evaluate(`window.__wm.state.recipient`), "c2");
  assert.equal(await evaluate(`!!document.querySelector('[data-key="payMode"][data-value="char"]')`), false);
  assert.match(await evaluate(`document.querySelector('[data-key="address"]').placeholder`), /宁妍 那边的地址/);
  await tap(`.whos [data-act="set-recipient"][data-id=""]`);
  await tap(`#btn-back`); await tap(`#btn-back`);

  // 首页左上角是收货地址，点开能改
  await tap(`#tabs [data-tab="home"]`);
  await tap(`[data-act="edit-address"]`);
  await evaluate(`(()=>{document.querySelector('#addr-input').value='梧桐里 3 栋 502'; return true})()`);
  await tap(`[data-act="save-address"]`); await sleep(150);
  assert.equal(await evaluate(`window.__wm.state.settings.userAddress`), "梧桐里 3 栋 502");
  assert.match(await text(".to"), /梧桐里 3 栋 502/);

  // 天天红包一天一张；只看收藏
  await evaluate(`(()=>{window.__wm.state.query=''; window.__wm.render(true); return true})()`);
  await tap(`[data-act="claim-daily"]`); await sleep(150);
  const couponCount = await evaluate(`window.__wm.state.coupons.length`);
  assert.ok(await evaluate(`window.__wm.state.coupons.some(c => c.reason === '天天红包')`));
  await tap(`[data-act="claim-daily"]`); await sleep(150);
  assert.equal(await evaluate(`window.__wm.state.coupons.length`), couponCount, "当天不会领第二张");
  await tap(`[data-act="toggle-filter"][data-key="onlyLiked"]`);
  assert.equal(await shopCount(), 1);
  await tap(`[data-act="toggle-filter"][data-key="onlyLiked"]`);

  // 9. 我的：开关能改、能存
  await tap(`#tabs [data-tab="me"]`);
  await shot("13-me");
  await scrollMain(420); await shot("13b-me-settings"); await scrollMain(0);
  await tap(`[data-act="toggle"][data-key="contextOn"]`); await sleep(150);
  assert.equal(await evaluate(`window.__wm.state.settings.contextOn`), false);
  assert.equal(await evaluate(`window.__handlers.provider({ characterId: 'c2' })`), "", "关掉后不再告诉角色");
  assert.equal(await evaluate(`window.__log.context.c2`), "", "常驻上下文也撤掉");
  await tap(`[data-act="toggle"][data-key="contextOn"]`); await sleep(150);

  // 10. 深色模式
  if (SHOTS) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await tap(`#tabs [data-tab="home"]`);
    await evaluate(`(()=>{window.__wm.state.query=''; window.__wm.render(true); return true})()`);
    await shot("14-home-dark");
    await tap(`#tabs [data-tab="orders"]`); await tap(`.order`);
    await shot("15-order-dark");
  }

  const bad = logs.filter(l => !/更新卡片失败|请求回复失败/.test(l));
  assert.deepEqual(bad, [], "页面不应该有报错或警告");
  console.log(`[wai-mai] 浏览器主流程检查通过。${SHOTS ? "截图：" + SHOTS : ""}`);
} catch (error) {
  console.error(error);
  if (logs.length) console.error("页面日志：\n" + logs.join("\n"));
  process.exitCode = 1;
} finally {
  try { socket.close(); } catch {}
  child.kill("SIGKILL");
}
