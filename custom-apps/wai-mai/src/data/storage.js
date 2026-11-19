// ── 数据：四个集合（settings 一行 / shops / orders / coupons），全量读进内存，写的时候同步回库 ──
const DEFAULT_SETTINGS = {
  speed: "fast",            // 新订单的配送速度
  incidents: true,          // 小插曲（下雨、绕路、少送）
  replyOnArrive: true,      // 和角色有关的订单送到后，请 TA 在聊天里说句话
  autoAccept: true,         // 角色给你点的外卖自动接单
  contextOn: true,          // 让角色在聊天里知道外卖进度
  aiShops: true,            // 搜不到时让模型现编几家店
  locale: "",               // 给模型的地区 / 风格提示，例如「上海」「架空古风小镇」
  userAddress: "", userTaboo: "",
  charAddress: {},          // charAddress[角色 id] = 地址
  hiddenSeeds: [],          // 隐藏的内置店 id
  likedShops: [],           // 收藏的店 id
  claimDay: "",             // 上次领每日红包的日期（YYYY-MM-DD）
};

async function listAll(collection) {
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await api.db.list(collection, { limit: 500, offset });
    const list = Array.isArray(page) ? page : (page && (page.items || page.records || page.rows)) || [];
    rows.push(...list);
    // 旧宿主不认 offset 会一直返回第一页：靠首条 id 重复来停
    if (list.length < 500 || (offset > 0 && rows[0] && list[0] && rows[0].id === list[0].id)) break;
  }
  return rows;
}

async function loadAll() {
  const [settingsRows, shops, orders, coupons] = await Promise.all([
    listAll("settings"), listAll("shops"), listAll("orders"), listAll("coupons"),
  ]);
  const row = settingsRows[0] || null;
  state.settingsId = row ? row.id : "";
  state.settings = { ...DEFAULT_SETTINGS, ...(row || {}) };
  if (!state.settings.charAddress || typeof state.settings.charAddress !== "object") state.settings.charAddress = {};
  if (!Array.isArray(state.settings.hiddenSeeds)) state.settings.hiddenSeeds = [];
  if (!Array.isArray(state.settings.likedShops)) state.settings.likedShops = [];
  state.aiShops = shops.map(s => ({ ...normalizeShop(s, s.source || "ai"), id: s.id })).filter(s => s.name && s.dishes.length);
  state.orders = orders.filter(o => o && o.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  state.coupons = coupons.filter(c => c && c.id);
}

async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  const data = {}; for (const key of Object.keys(DEFAULT_SETTINGS)) data[key] = state.settings[key];
  if (state.settingsId) await api.db.update("settings", state.settingsId, data);
  else state.settingsId = (await api.db.create("settings", data)).id;
}

function allShops() {
  const hidden = new Set(state.settings.hiddenSeeds);
  return [...state.aiShops.filter(s => !s.hidden), ...SEEDS.filter(s => !hidden.has(s.id))];
}
function shopById(id) { return state.aiShops.find(s => s.id === id) || SEEDS.find(s => s.id === id) || null; }

async function addAiShops(list, query) {
  const added = [];
  for (const raw of list) {
    const shop = normalizeShop({ ...raw, query }, "ai");
    if (!shop.name || shop.dishes.length < 2) continue;
    if (allShops().some(s => s.name === shop.name)) continue;
    const { id: _drop, ...data } = shop;
    const row = await api.db.create("shops", { ...data, createdAt: Date.now() });
    const saved = { ...shop, id: row.id };
    state.aiShops.unshift(saved); added.push(saved);
  }
  return added;
}
async function removeShop(id) {
  if (id.startsWith("seed_")) { await saveSettings({ hiddenSeeds: [...new Set([...state.settings.hiddenSeeds, id])] }); return; }
  await api.db.delete("shops", id);
  state.aiShops = state.aiShops.filter(s => s.id !== id);
}

async function createOrder(data) {
  const row = await api.db.create("orders", data);
  const order = { ...data, id: row.id };
  state.orders.unshift(order);
  return order;
}
async function patchOrder(order, patch) {
  Object.assign(order, patch);
  await api.db.update("orders", order.id, patch);
  return order;
}
async function deleteOrder(order) {
  await api.db.delete("orders", order.id);
  state.orders = state.orders.filter(o => o.id !== order.id);
}
function orderById(id) { return state.orders.find(o => o.id === id) || null; }

async function addCoupon(amount, reason) {
  const data = { amount: Math.round(amount * 10) / 10, reason, used: false, createdAt: Date.now() };
  const row = await api.db.create("coupons", data);
  const coupon = { ...data, id: row.id };
  state.coupons.push(coupon);
  return coupon;
}
function usableCoupons() { return state.coupons.filter(c => !c.used).sort((a, b) => b.amount - a.amount); }
async function useCoupon(coupon, orderId) {
  coupon.used = true; coupon.usedOrderId = orderId;
  await api.db.update("coupons", coupon.id, { used: true, usedOrderId: orderId });
}

/** 某个人最近常点的菜（从订单里数），给聊天上下文和「猜你想吃」用 */
function favorites(recipient, limit = 4) {
  const count = new Map();
  for (const o of state.orders) {
    if (o.status !== "active" || (o.recipient || "") !== recipient) continue;
    for (const it of o.items || []) count.set(it.name, (count.get(it.name) || 0) + (it.qty || 1));
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name);
}

/** 订单号：日期 + 当天第几单，给人看的 */
function nextOrderNo(now) {
  const d = new Date(now), day = `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const n = state.orders.filter(o => String(o.no || "").startsWith(day)).length + 1;
  return `${day}-${pad2(n)}`;
}
