#!/usr/bin/env node
// 外卖 APP 的配送时间线和计价：纯函数，直接把 src/domain/delivery.js 放进 vm 里跑。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(resolve(root, "custom-apps/wai-mai/src/domain/delivery.js"), "utf8");
const d = runInNewContext(`(function(){ ${code}\n return { SPEEDS, STAGE_ORDER, buildTimeline, stageAt, scaleRemaining, changeSpeed, urge, remainText, priceOrder }; })()`, { Date, Math, Number, String, Array });

const T0 = Date.UTC(2026, 10, 19, 4, 0, 0);
const items = [{ name: "红烧牛肉面", price: 24, qty: 1 }, { name: "卤蛋", price: 3, qty: 2 }];
const base = { seed: "1119-01|巷尾面馆|1", startAt: T0, speed: "fast", incidents: false, items, shopFactor: 1 };

// 同一个种子永远出同一条时间线
const a = d.buildTimeline(base), b = d.buildTimeline(base);
assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
assert.equal(a.timeline[0].key, "placed");
assert.equal(a.timeline[0].at, T0);
assert.equal(a.timeline.at(-1).key, "delivered");
assert.equal(a.timeline.at(-1).at, a.deliverAt);
assert.ok(a.timeline.every((e, i, list) => i === 0 || e.at >= list[i - 1].at), "时间线按时间排好");
assert.equal(a.issue, null);

// 三档速度各自落在自己的时长范围里（不开小插曲时只受店铺系数影响）
for (const [key, speed] of Object.entries(d.SPEEDS)) {
  for (let i = 0; i < 40; i++) {
    const t = d.buildTimeline({ ...base, seed: `s${key}${i}`, speed: key });
    const minutes = (t.deliverAt - T0) / 60000;
    assert.ok(minutes >= speed.minutes[0] - 0.01 && minutes <= speed.minutes[1] + 0.01, `${key} ${minutes}`);
  }
}

// 小插曲：少送的一定是订单里的东西，金额大于 0；只有一样东西时不会少送
let delays = 0, issues = 0;
for (let i = 0; i < 400; i++) {
  const t = d.buildTimeline({ ...base, seed: `inc${i}`, incidents: true });
  if (t.issue) {
    issues++;
    assert.ok(t.issue.amount > 0);
    if (t.issue.type === "missing") assert.ok(items.some(it => it.name === t.issue.item));
    assert.ok(t.timeline.at(-1).text.includes(t.issue.text));
  }
  if (t.timeline.some(e => /下起了小雨|绕了一段|等电梯|出餐排队|多取了一单/.test(e.text))) delays++;
  const single = d.buildTimeline({ ...base, seed: `inc${i}`, incidents: true, items: items.slice(0, 1) });
  if (single.issue) assert.equal(single.issue.type, "spilled");
}
assert.ok(delays > 40 && delays < 140, `延误出现次数 ${delays}`);
assert.ok(issues > 10 && issues < 70, `问题单出现次数 ${issues}`);

// 预约：晚于最快送达就准点送到；早于最快送达当成尽快
const later = d.buildTimeline({ ...base, scheduledFor: T0 + 2 * 3600000 });
assert.equal(later.deliverAt, T0 + 2 * 3600000);
assert.ok(later.timeline.find(e => e.key === "cooking").at > T0 + 3600000, "预约单到点前才开始做");
assert.ok(later.timeline.find(e => e.key === "accepted").at <= T0 + 60000, "预约单马上接单");
const tooSoon = d.buildTimeline({ ...base, scheduledFor: T0 + 30000 });
assert.equal(tooSoon.deliverAt, a.deliverAt);

// 现在到哪一步
const order = { ...a, speed: "fast" };
assert.equal(d.stageAt(order, T0).key, "placed");
const mid = d.stageAt(order, T0 + (a.deliverAt - T0) * 0.5);
assert.equal(mid.key, "picked");
assert.ok(mid.progress > 0.4 && mid.progress < 0.6 && !mid.delivered);
const done = d.stageAt(order, a.deliverAt);
assert.ok(done.delivered && done.key === "delivered" && done.progress === 1 && done.remainMs === 0);
assert.equal(d.stageAt({ timeline: [] }, T0), null);

// 中途换速度：走过的不动，剩下的按比例缩
const half = T0 + (a.deliverAt - T0) * 0.5;
const faster = d.changeSpeed(order, half, "flash");
assert.equal(faster.speed, "flash");
assert.ok(faster.deliverAt > half && faster.deliverAt < a.deliverAt);
order.timeline.forEach((e, i) => { if (e.at <= half) assert.equal(faster.timeline[i].at, e.at); });
const slower = d.changeSpeed(order, half, "real");
assert.ok(slower.deliverAt > a.deliverAt);

// 催单：快两成，多一条骑手回话
const urged = d.urge({ ...order, rider: a.rider }, half);
assert.equal(urged.urged, true);
assert.ok(Math.abs((urged.deliverAt - half) - (a.deliverAt - half) * 0.8) <= 1);
assert.ok(urged.timeline.some(e => e.at === half && e.text.includes("催单")));
assert.ok(urged.timeline.every((e, i, list) => i === 0 || e.at >= list[i - 1].at));
assert.ok(d.urge(order, T0 + 1000).timeline.some(e => e.text.includes("商家说马上出餐")));

// 计价
const shop = { fee: 2.5, minOrder: 12, off: [30, 4] };
assert.deepEqual({ ...d.priceOrder(items, shop, 0) }, { subtotal: 30, pack: 0, fee: 2.5, feeOff: 0, off: 4, pickupOff: 0, coupon: 0, total: 28.5, short: 0 });
// 包装费、免运费、自取
const packed = { ...shop, pack: 1 };
assert.equal(d.priceOrder(items, packed, 0).total, 29.5, "包装费一单 1 元");
assert.equal(d.priceOrder(items, packed, { freeFee: true }).total, 27, "会员或运费券免配送费");
const pick = d.priceOrder(items, packed, { pickup: true, freeFee: true });
assert.deepEqual([pick.fee, pick.feeOff, pick.pickupOff, pick.total, pick.short], [0, 0, 3, 24, 0], "自取不收配送费、立减一成、没有起送价");
assert.equal(d.priceOrder([{ name: "卤蛋", price: 3, qty: 1 }], shop, { pickup: true }).short, 0);
assert.equal(d.priceOrder([{ name: "大单", price: 200, qty: 1 }], shop, { pickup: true }).pickupOff, 10, "自取立减最多 10 元");
assert.equal(d.priceOrder(items, packed, { coupon: 5 }).coupon, 5, "对象写法的红包");
assert.equal(d.priceOrder(items, shop, 100).total, 0, "红包不会让合计变成负数");
assert.equal(d.priceOrder(items, shop, 100).coupon, 28.5);
assert.equal(d.priceOrder([{ name: "卤蛋", price: 3, qty: 1 }], shop, 0).short, 9);
assert.equal(d.priceOrder([{ name: "卤蛋", price: 3, qty: 1 }], shop, 0).off, 0);

// 到店自取：没有骑手，餐好即「送达」，比配送快
const pk = d.buildTimeline({ ...base, seed: "pk1", mode: "pickup", code: "A123", incidents: true });
assert.equal(pk.rider, ""); assert.equal(pk.issue, null);
assert.ok(pk.timeline.every(e => !["picked", "riding", "near"].includes(e.key)), "自取没有取餐配送这几步");
assert.match(pk.timeline.at(-1).text, /取餐码 A123/);
assert.ok(pk.deliverAt - T0 < a.deliverAt - T0, "自取比配送快");
// 跑腿：骑手先去买；指定骑手名字
const er = d.buildTimeline({ ...base, seed: "er1", mode: "errand", storeName: "邻家超市", riderName: "沈烬言" });
assert.equal(er.rider, "沈烬言");
assert.ok(er.timeline.some(e => e.text.includes("到邻家超市了")));
assert.ok(!er.timeline.some(e => e.text.includes("商家")), "跑腿的动态里没有商家");
assert.equal(d.buildTimeline({ ...base, riderName: "宁妍" }).rider, "宁妍");

assert.equal(d.remainText(0), "已送达");
assert.equal(d.remainText(30000), "约 30 秒后送达");
assert.equal(d.remainText(5 * 60000), "约 5 分钟后送达");

console.log("[wai-mai] 配送时间线与计价检查通过。");
