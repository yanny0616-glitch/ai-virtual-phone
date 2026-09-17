#!/usr/bin/env node
// 变数：App 的 domain/forks.mjs 和两份云函数里的带类型副本要算出一样的结果，否则手机和云端各说各的
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as forks from "../custom-apps/gua-nian/src/domain/forks.mjs";

const START = "// ── 变数（App 同名", END = "// ── 变数副本结束";
function region(file) {
  const text = readFileSync(new URL("../public/ai-phone-push/" + file, import.meta.url), "utf8");
  const a = text.indexOf(START), b = text.indexOf(END);
  assert.ok(a >= 0 && b > a, file + " 缺少变数副本");
  return text.slice(a, b + END.length);
}
const copy = region("push-recheck.mjs");
assert.equal(region("push-generate.mjs"), copy, "push-recheck 与 push-generate 的变数副本必须逐字相同");
const js = ts.transpileModule(copy, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const cloud = new Function(js + "\nreturn { guanianNormalizeForks, guanianApplyForks, guanianForkSay, guanianForkNotes, guanianForkRoll, guanianForkDay };")();

const schedule = [
  { time: "08:30", end: "09:00", title: "起床，煮咖啡" },
  { time: "10:00", end: "12:00", title: "去店里备货" },
  { time: "14:00", end: "15:00", title: "面试新店员", busy: true },
  { time: "17:00", end: "21:00", title: "开店", busy: true },
  { time: "21:30", end: "22:30", title: "对账" },
];
const raw = [
  { at: "17:00", time: "17:40", what: "熟客抱来一只路边捡的小猫", label: "捡了只猫", p: 30, mood: "心软", energy: -2, tell: "忍不住", add: null, move: [], drop: ["21:30"] },
  { at: "14:00", time: "14:10", what: "来面试的人居然是他高中同桌，聊了四十分钟", label: "遇见老同桌", p: 50, mood: "惊喜又恍惚", energy: 3, tell: "聊到才说",
    add: { time: "15:00", end: "16:30", title: "和老同桌去喝一杯", place: "江边", busy: "false" }, move: [{ time: "21:30", newTime: "23:00" }, { time: "09:00", newTime: "10:00" }], drop: [] },
  { at: "25:99", what: "锚点不存在" },
  { at: "10:00", what: "平常档只留两个" },
];

// 归一：档位管个数和概率，锚点不在日程里的丢掉，按揭晓先后排
for (const level of [0, 1, 2, "2", undefined]) assert.deepEqual(cloud.guanianNormalizeForks(raw, schedule, level), forks.normalizeForks(raw, schedule, level));
const norm = forks.normalizeForks(raw, schedule, 1);
assert.equal(norm.length, 2);
assert.deepEqual(norm.map(f => f.at), ["14:00", "17:00"]);
assert.deepEqual(norm.map(f => f.p), [50, 30]);
assert.deepEqual(norm.map(f => f.tell), ["hint", "burst"]);
assert.equal(norm[0].off, 10);
assert.deepEqual(norm[0].add, { time: "15:00", end: "16:30", title: "和老同桌去喝一杯", place: "江边", cost: 0, busy: false });
assert.deepEqual(norm[0].move, [{ time: "21:30", to: "23:00", title: "对账" }], "揭晓之前的事不许挪");
assert.deepEqual(norm[1].drop, [{ time: "21:30", title: "对账" }]);
assert.equal(forks.normalizeForks(raw, schedule, 0).length, 1);
assert.equal(forks.normalizeForks(raw, schedule, 0)[0].p, 14);
assert.equal(forks.normalizeForks(raw, schedule, 2).find(f => f.at === "14:00").p, 68);
assert.deepEqual(forks.normalizeForks("不是数组", schedule, 1), []);

const [meet, cat] = norm;
const seedWhere = (want) => {
  for (let i = 0; i < 5000; i++) {
    const seed = "2026-09-15|c" + i;
    if (want(forks.forkRoll(seed + "|" + meet.id) < meet.p, forks.forkRoll(seed + "|" + cat.id) < cat.p)) return seed;
  }
  throw new Error("找不到种子");
};
const onlyMeet = seedWhere((a, b) => a && !b), onlyCat = seedWhere((a, b) => !a && b);
const at = (hm) => Date.UTC(2026, 8, 15, +hm.slice(0, 2), +hm.slice(3));
const base = { date: "2026-09-15", schedule, conds: [], forks: norm };
const both = (day, hm, opts) => {
  const a = forks.applyDueForks(day, hm, opts), b = cloud.guanianApplyForks(day, hm, opts);
  assert.deepEqual(b, a, "App 和云端结算结果不一致：" + hm);
  return a;
};

// 没到揭晓时刻什么都不动
assert.equal(both(base, "14:09", { seed: onlyMeet, at }).revealed.length, 0);
// 到点揭晓：插进一段、后面的推迟、心情记一笔
const r1 = both(base, "14:10", { seed: onlyMeet, at });
assert.deepEqual(r1.revealed.map(f => [f.id, f.state, f.say]), [[meet.id, "hit", "hint"]]);
const inserted = r1.day.schedule.find(it => it.fork === meet.id);
assert.equal(inserted.title, "和老同桌去喝一杯");
const moved = r1.day.schedule.find(it => it.title === "对账");
assert.deepEqual([moved.time, moved.end, moved.moved], ["23:00", "23:59", true]);
assert.deepEqual(r1.day.conds, [{ mood: "惊喜又恍惚", cause: "遇见老同桌", energyDelta: 3, intensity: 70, halfLifeMin: 240, startAt: at("14:10") }]);
assert.equal(schedule.find(it => it.title === "对账").time, "21:30", "不能改动传入的日程");
// 已结算的不再结算：重复调用、或 App 先结算过再交给云端，结果都一样
const again = both(r1.day, "14:30", { seed: onlyMeet, at });
assert.equal(again.revealed.length, 0);
assert.equal(again.day, r1.day);
const r2 = both(r1.day, "18:00", { seed: onlyMeet, at });
assert.deepEqual(r2.revealed.map(f => f.state), ["miss"]);
assert.deepEqual(both(base, "18:00", { seed: onlyMeet, at }).day, r2.day, "一次结算两个和分两次结算要一样");
// 另一个种子：猫来了，对账取消；忍不住按好感挪档
const r3 = both(base, "20:00", { seed: onlyCat, at, score: 20 });
assert.ok(!r3.day.schedule.some(it => it.title === "对账"));
assert.equal(r3.revealed.find(f => f.id === cat.id).say, "hint");
// 锚点被聊天删掉：作废；被挪走：跟着新时刻揭晓
const noShop = { ...base, schedule: schedule.filter(it => it.title !== "开店") };
assert.equal(both(noShop, "23:00", { seed: onlyCat, at }).revealed.find(f => f.id === cat.id).state, "void");
const later = { ...base, schedule: schedule.map(it => it.title === "面试新店员" ? { ...it, time: "15:00", end: "16:00" } : it) };
assert.equal(both(later, "14:30", { seed: onlyMeet, at }).revealed.length, 0);
assert.equal(both(later, "15:10", { seed: onlyMeet, at }).revealed[0].at, "15:10");

for (const [tell, score, want] of [["keep", 70, "hint"], ["hint", 85, "burst"], ["burst", 20, "hint"], ["hint", 10, "keep"], ["keep", undefined, "keep"], ["burst", null, "burst"], ["乱写", 50, "hint"]]) {
  assert.equal(forks.forkSay(tell, score), want, `${tell}/${score}`);
  assert.equal(cloud.guanianForkSay(tell, score), want);
}
assert.deepEqual(cloud.guanianForkNotes(r1.day), forks.forkNotes(r1.day));
assert.match(forks.forkNotes(r1.day)[0], /^今天 14:10 碰上一件事：来面试的人/);
assert.deepEqual(forks.forkNotes(base), []);

// 云端按日程里的时区换算此刻：东八区 14:30 已揭晓，揭晓时刻换成同一个绝对时间
const tzDay = { ...base, tz: 480, forkSeed: onlyMeet };
const cloudDay = cloud.guanianForkDay(tzDay, Date.UTC(2026, 8, 15, 6, 30), { score: 50 });
const appDay = forks.applyDueForks(tzDay, "14:30", { seed: onlyMeet, score: 50, at: (hm) => Date.UTC(2026, 8, 15, +hm.slice(0, 2) - 8, +hm.slice(3)) }).day;
assert.deepEqual(cloudDay, appDay);
assert.equal(cloud.guanianForkDay({ ...tzDay, forks: [] }, Date.now()).forks.length, 0);

console.log("[gua-nian-forks] 变数归一、结算、说不说与云端副本一致");
