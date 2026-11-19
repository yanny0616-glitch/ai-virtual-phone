// ── 配送时间线（纯函数，不碰 DOM 和 SDK；scripts/check-wai-mai-domain.mjs 直接拿这个文件跑）──
// 下单那一刻就把整条时间线算好存进订单：之后「现在到哪一步」只是拿当前时间去对表，
// APP 关着、小手机关着都不影响结果，重开后对一下表就知道送到没有。

const SPEEDS = {
  real: { label: "真实时间", hint: "半小时上下", minutes: [28, 44] },
  fast: { label: "快速", hint: "几分钟", minutes: [3, 5] },
  flash: { label: "极速", hint: "一分钟内", minutes: [0.6, 1] },
};
const STAGE_LABEL = {
  placed: "已下单", accepted: "商家已接单", cooking: "备餐中", picked: "骑手已取餐",
  riding: "配送中", near: "即将送达", delivered: "已送达",
};
const STAGE_ORDER = ["placed", "accepted", "cooking", "picked", "riding", "near", "delivered"];
const RIDERS = ["阿澈", "老周", "小满", "阿芒", "大刘", "阿树", "小唐", "阿迪"];
// 只改口头说法、会拖慢一点的小插曲
const DELAYS = [
  { text: "外面下起了小雨，骑手放慢了车速", extra: 0.12 },
  { text: "前面路口在修路，骑手绕了一段", extra: 0.14 },
  { text: "骑手在等电梯，这栋楼电梯有点慢", extra: 0.08 },
  { text: "商家出餐排队，稍微晚了几分钟", extra: 0.1 },
  { text: "骑手顺路多取了一单，正在赶过来", extra: 0.1 },
];

function hashSeed(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** mulberry32：同一个种子永远出同一串数，订单的时间线可以复算 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param o.seed        订单号之类的稳定字符串
 * @param o.startAt     开始配送的时刻（付款成功时），毫秒
 * @param o.speed       real / fast / flash
 * @param o.incidents   是否允许小插曲
 * @param o.items       [{ name, price, qty }]，少送时从里面挑一样
 * @param o.scheduledFor 约定送达时刻（毫秒），早于最快送达时间就当「尽快」
 * @param o.shopFactor  店铺快慢系数，1 为正常
 * @returns {{ timeline: {at:number,key:string,text:string}[], deliverAt:number, rider:string, issue:null|object }}
 */
function buildTimeline(o) {
  const rng = makeRng(hashSeed(o.seed));
  const speed = SPEEDS[o.speed] || SPEEDS.fast;
  const [lo, hi] = speed.minutes;
  let total = (lo + (hi - lo) * rng()) * 60000 * clampNumber(o.shopFactor || 1, 0.7, 1.5);
  const rider = RIDERS[Math.floor(rng() * RIDERS.length)];

  let delay = null, issue = null;
  const roll = rng();
  if (o.incidents) {
    if (roll < 0.22) delay = DELAYS[Math.floor(rng() * DELAYS.length)];
    else if (roll < 0.3) issue = pickIssue(o.items || [], rng);
  }
  if (delay) total *= 1 + delay.extra;

  // 预约单：商家先接单，到点前再开始做
  let kitchenStart = o.startAt;
  const scheduled = Number(o.scheduledFor) > o.startAt + total;
  if (scheduled) kitchenStart = o.scheduledFor - total;
  const at = f => Math.round(kitchenStart + total * f);

  const timeline = [{ at: o.startAt, key: "placed", text: "订单已提交" }];
  if (scheduled) {
    timeline.push({ at: o.startAt + Math.min(60000, total * 0.03), key: "accepted", text: `商家已接单，会按约定时间 ${clock(o.scheduledFor)} 送达` });
  } else {
    timeline.push({ at: at(0.03), key: "accepted", text: "商家已接单" });
  }
  timeline.push({ at: at(0.1), key: "cooking", text: "商家正在备餐" });
  if (delay && delay.text.startsWith("商家")) timeline.push({ at: at(0.3), key: "cooking", text: delay.text });
  timeline.push({ at: at(0.45), key: "picked", text: `骑手${rider}已取餐，正在赶来` });
  timeline.push({ at: at(0.6), key: "riding", text: `骑手${rider}距离收货地还有 ${(1.2 + rng() * 1.6).toFixed(1)} 公里` });
  if (delay && !delay.text.startsWith("商家")) timeline.push({ at: at(0.7), key: "riding", text: delay.text });
  timeline.push({ at: at(0.82), key: "riding", text: `骑手${rider}距离收货地还有 ${(0.3 + rng() * 0.5).toFixed(1)} 公里` });
  timeline.push({ at: at(0.93), key: "near", text: "骑手已到楼下，马上送到" });
  const deliverAt = at(1);
  timeline.push({ at: deliverAt, key: "delivered", text: issue ? `已送达。${issue.text}` : "已送达，趁热吃" });
  timeline.sort((a, b) => a.at - b.at);
  return { timeline, deliverAt, rider, issue };
}

function pickIssue(items, rng) {
  const list = items.filter(it => it && it.name);
  if (list.length >= 2 && rng() < 0.6) {
    const it = list[Math.floor(rng() * list.length)];
    return { type: "missing", item: it.name, amount: Number(it.price) || 0, text: `打开一看，少送了一份「${it.name}」`, resolved: "" };
  }
  const sum = list.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
  return { type: "spilled", item: "", amount: Math.max(2, Math.round(sum * 0.2)), text: "包装有点洒了，汤汁漏出来一些", resolved: "" };
}

function clampNumber(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n) || 0)); }
function clock(t) { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

/** 此刻到哪一步了。订单没有时间线（还没付款）时返回 null */
function stageAt(order, now) {
  const timeline = order && Array.isArray(order.timeline) ? order.timeline : [];
  if (!timeline.length) return null;
  let current = timeline[0];
  for (const entry of timeline) { if (entry.at <= now) current = entry; else break; }
  const delivered = now >= order.deliverAt;
  const start = timeline[0].at;
  return {
    key: delivered ? "delivered" : current.key,
    label: STAGE_LABEL[delivered ? "delivered" : current.key] || "",
    text: current.text,
    delivered,
    remainMs: Math.max(0, order.deliverAt - now),
    progress: delivered ? 1 : clampNumber((now - start) / Math.max(1, order.deliverAt - start), 0, 0.98),
    passed: timeline.filter(entry => entry.at <= now),
  };
}

/** 还没到的时间点整体按比例压缩或拉长；已经走过的不动 */
function scaleRemaining(order, now, factor) {
  const f = clampNumber(factor, 0.02, 50);
  const move = t => (t <= now ? t : Math.round(now + (t - now) * f));
  return {
    timeline: order.timeline.map(entry => ({ ...entry, at: move(entry.at) })),
    deliverAt: move(order.deliverAt),
  };
}

/** 中途换配送速度：剩下的路按两档速度的中位数之比缩放 */
function changeSpeed(order, now, nextSpeed) {
  const mid = key => { const s = SPEEDS[key] || SPEEDS.fast; return (s.minutes[0] + s.minutes[1]) / 2; };
  const scaled = scaleRemaining(order, now, mid(nextSpeed) / mid(order.speed));
  return { ...scaled, speed: nextSpeed };
}

/** 催单：剩下的路快两成，时间线里插一条骑手回话。只能催一次 */
function urge(order, now) {
  const scaled = scaleRemaining(order, now, 0.8);
  const cooking = !order.timeline.some(entry => entry.key === "picked" && entry.at <= now);
  const text = cooking ? "已帮你催单，商家说马上出餐" : `已帮你催单，骑手${order.rider || ""}回复：马上到`;
  const timeline = [...scaled.timeline, { at: now, key: stageKeyAt(order, now), text }].sort((a, b) => a.at - b.at);
  return { timeline, deliverAt: scaled.deliverAt, urged: true };
}
function stageKeyAt(order, now) {
  let key = "placed";
  for (const entry of order.timeline) { if (entry.at <= now) key = entry.key; }
  return key;
}

/** 剩余时间的口头说法 */
function remainText(ms) {
  if (ms <= 0) return "已送达";
  if (ms < 60000) return `约 ${Math.max(1, Math.round(ms / 1000))} 秒后送达`;
  return `约 ${Math.round(ms / 60000)} 分钟后送达`;
}

/** 订单金额：小计 + 配送费 - 满减 - 红包，不会低于 0 */
function priceOrder(items, shop, couponAmount) {
  const subtotal = round1(items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0));
  const fee = Number(shop && shop.fee) || 0;
  const off = shop && Array.isArray(shop.off) && subtotal >= Number(shop.off[0]) ? Number(shop.off[1]) || 0 : 0;
  const before = Math.max(0, round1(subtotal + fee - off));
  const coupon = Math.min(before, Math.max(0, Number(couponAmount) || 0));
  return { subtotal, fee, off, coupon: round1(coupon), total: round1(before - coupon), short: Math.max(0, round1((Number(shop && shop.minOrder) || 0) - subtotal)) };
}
function round1(n) { return Math.round(n * 10) / 10; }
