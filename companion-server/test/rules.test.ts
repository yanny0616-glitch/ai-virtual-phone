import assert from "node:assert/strict";
import test from "node:test";

import { calendarReality, parseDayResult } from "../src/day.ts";
import { guanianAsleep, guanianNow, stateNote } from "../src/life.ts";
import { appendUserNote, buildTaskRequest, parseModelJson, splitPreview, visibleResponse } from "../src/llm.ts";
import { feedbackWindowEnd, impulseValue, parseJudgeJson, valueFloor } from "../src/rules.ts";
import { parseWhen, settleByWords } from "../src/threads.ts";
import type { GuanianDay, Thread } from "../src/types.ts";

const TZ = 480;
const at = (local: string) => Date.parse(local + ":00+08:00");

const day: GuanianDay = {
  tz: TZ, mood: "松弛", energy: 80, wake: "08:00", bed: "23:30",
  schedule: [
    { time: "09:00", end: "11:00", title: "开会", cost: -6, mood: "脑子发紧", busy: true },
    { time: "12:00", end: "13:00", title: "吃午饭", cost: 3, mood: "满足" },
  ],
  conds: [],
};

test("此刻状态：在做的事、忙完、睡着", () => {
  const meeting = guanianNow(day, at("2026-09-16T10:00"));
  assert.equal(meeting.doing, "开会");
  assert.equal(meeting.next, "12:00 吃午饭");
  const after = guanianNow(day, at("2026-09-16T11:30"));
  assert.match(after.doing, /歇着（刚忙完开会）/);
  assert.match(after.mood, /脑子发紧（开会之后）/);
  assert.ok(guanianAsleep(day, "02:00"));
  assert.ok(!guanianAsleep(day, "22:00"));
  const note = stateNote(day, at("2026-09-16T10:00"), undefined, undefined, { tier: "喜欢", relation: "恋人" }, ["约定·看电影（今天 20:00）"]);
  assert.match(note, /在做的事：开会/);
  assert.match(note, /恋人/);
  assert.match(note, /看电影/);
});

test("分量与额度卡槛", () => {
  assert.equal(valueFloor(1), 0.65);
  assert.equal(valueFloor(2), 0.45);
  assert.equal(valueFloor(3), 0);
  assert.ok(impulseValue("fork", 1, {}) > impulseValue("quiet", 1, {}));
  assert.ok(impulseValue("miss", 1, { miss: [10, 8] }) > impulseValue("miss", 1, {}));
  assert.equal(impulseValue("done", 0, {}), 0);
});

test("回音窗口：3 小时满才结算，用户睡眠时段不计时", () => {
  const sent = at("2026-09-16T22:00");
  assert.equal(feedbackWindowEnd(sent, { tzOffsetMin: TZ }, sent + 2 * 3600_000), null);
  assert.equal(feedbackWindowEnd(sent, { tzOffsetMin: TZ }, sent + 4 * 3600_000), sent + 3 * 3600_000);
  const ctx = { tzOffsetMin: TZ, userSleepOn: 1, userSleepStart: "23:00", userSleepEnd: "07:00", userSleepTz: TZ };
  assert.equal(feedbackWindowEnd(sent, ctx, at("2026-09-17T06:00")), null);
  assert.equal(feedbackWindowEnd(sent, ctx, at("2026-09-17T12:00")), at("2026-09-17T09:00"));
});

test("用户一句话了结账本，问句和否定不算", () => {
  const threads = (): Thread[] => [
    { id: "p1", kind: "promise", text: "周五交报告", due: 1 },
    { id: "t1", kind: "topic", text: "猫咪体检" },
  ];
  const a = threads();
  assert.deepEqual(settleByWords(a, ["报告交了"], 5).map(x => x.id), ["p1"]);
  assert.equal(a[0].status, "completed");
  assert.deepEqual(settleByWords(threads(), ["报告还没交了吗？"], 5), []);
  assert.deepEqual(settleByWords(threads(), ["猫咪体检算了"], 5).map(x => x.id), ["t1"]);
});

test("时间解析按时区折算", () => {
  const now = at("2026-09-16T10:00");
  assert.equal(parseWhen("2026-09-18 15:30", now, TZ), at("2026-09-18T15:30"));
  assert.equal(parseWhen("明天 09:00", now, TZ), at("2026-09-17T09:00"));
  assert.equal(parseWhen("15:00", now, TZ), at("2026-09-16T15:00"));
  assert.equal(parseWhen("乱写", now, TZ), 0);
});

test("模型输出解析：JSON 抽取、思考块、预览分条", () => {
  assert.deepEqual(parseModelJson('好的：```json\n{"a":1}\n``` 以上'), { a: 1 });
  assert.throws(() => parseModelJson("没有"), /没回 JSON/);
  const judged = parseJudgeJson('前言 {"decisions":[],"extra":[{"time":"10:30","intent":"想说"}],"keep":[],"settle":["t1"],"post":{"hint":"晒猫"}}');
  assert.equal(judged.extra[0].time, "10:30");
  assert.equal(judged.post, "晒猫");
  assert.deepEqual(visibleResponse("<thinking>想想</thinking>你好呀", undefined), { text: "你好呀", reasoningText: "想想" });
  assert.throws(() => visibleResponse("<thinking>没写完", undefined));
  assert.deepEqual(splitPreview("第一段\n\n[表情包:开心]\n\n[内心]不说[/内心]"), ["第一段", "[表情包]"]);
});

test("任务请求：有占位符替换，没有就追加；不改原模板", () => {
  const tpl = { url: "https://x", headers: {}, providerKind: "anthropic" as const, body: { messages: [{ role: "user", content: [{ type: "text", text: "[挂念] __CUSTOM_APP_INSTRUCTION__" }] }], tools: [1] } };
  const filled = buildTaskRequest(tpl, "做事");
  assert.match(JSON.stringify(filled.body), /\[挂念\] 做事/);
  assert.equal(filled.body.tools, undefined);
  assert.match(JSON.stringify(tpl.body), /__CUSTOM_APP_INSTRUCTION__/);
  const plain = { url: "https://x", headers: {}, providerKind: "openai-compatible" as const, body: { messages: [{ role: "user", content: "hi" }] } };
  const appended = buildTaskRequest(plain, "做事");
  assert.equal((appended.body.messages as unknown[]).length, 2);
  const gem = { contents: [] as unknown[] };
  assert.ok(appendUserNote(gem, "gemini", "备忘"));
  assert.deepEqual(gem.contents, [{ role: "user", parts: [{ text: "备忘" }] }]);
});

test("生成一天：归一字段、补回日程表已定安排、日历现实", () => {
  const parsed = parseDayResult({
    mood: "清爽", energy: 85, wake: "7:30", bed: "23:00",
    schedule: [{ time: "09:00", end: "08:00", title: "上课", busy: "true" }, { time: "12:00", title: "吃饭", cost: 99 }],
  }, [{ startTime: "15:00", title: "看牙", lock: "busy" }], {}, 1);
  assert.equal(parsed.wake, "07:30");
  assert.deepEqual(parsed.schedule.map(s => s.time), ["09:00", "12:00", "15:00"]);
  assert.equal(parsed.schedule[0].end, "");
  assert.equal(parsed.schedule[0].busy, true);
  assert.equal(parsed.schedule[1].cost, 15);
  assert.equal(parsed.schedule[2].busy, true);
  assert.throws(() => parseDayResult({}, [], {}, 1), /日程缺失/);
  assert.match(calendarReality("2026-10-03").label, /周六（周末、国庆假期）/);
});

test("空气泡不算一轮没回", async () => {
  const { readHistory, unansweredRounds } = await import("../src/history.ts");
  const rows = [
    { id: "u1", role: "user", content: "哦", message_at: "2026-09-16T06:39:49Z" },
    { id: "a1", role: "assistant", content: "", message_at: "2026-09-16T06:42:39Z" },
    { id: "a2", role: "assistant", content: "  ", message_at: "2026-09-16T06:48:23Z" },
    { id: "a3", role: "assistant", content: "晚上回来吃吗", message_at: "2026-09-16T11:31:39Z" },
  ];
  const rest = async (path: string) => new Response(JSON.stringify(path.startsWith("push_chat_mirror?") && !path.includes("media_type=eq.") ? rows : []));
  const history = await readHistory(rest, "u", "s");
  assert.deepEqual(history.messages.map(m => m.id), ["u1", "a3"]);
  assert.equal(unansweredRounds(history, Date.parse("2026-09-16T20:19:00Z")), 1);
});

test("同一件事的字面兜底：0916 念头撞约定、0914 催睡撞约定会拦，不相关的放过", async () => {
  const { similarBlock, textSimilarity } = await import("../src/similar.ts");
  const promise = (text: string): Thread => ({ id: "p", kind: "promise", text, due: 1 });
  assert.match(similarBlock("回她中午问的那句话，问她课上完没、晚上回不回来吃饭", [], [promise("晚上回去当面回她中午的话")], []), /交给约定/);
  assert.match(similarBlock("再问一句她刚才在刷什么，顺便催她别熬到太晚，十一点半前睡", [], [promise("喝完奶茶十一点半前睡")], []), /交给约定/);
  assert.equal(similarBlock("问她下午课怎么样", [], [promise("三点半回家看她，白粥备好")], []), "");
  assert.ok(textSimilarity("三点半回家看她，白粥备好", "喝完奶茶十一点半前睡") < 0.3);
  const sent = { time: "16:20", act: true, kind: "extra", intent: "问她起来没有、下去吃东西了没有，说一句自己在客厅", generatedAt: Date.parse("2026-09-12T08:20:00Z") } as never;
  const again = "问她起来了没有，刘阿姨温着的东西下去吃，别再空着肚子";
  assert.match(similarBlock(again, [sent], [], []), /发过的是同一件事/);
  const replied = [{ id: "u", role: "user", content: "起了", message_at: "2026-09-12T09:00:00Z" }];
  assert.equal(similarBlock(again, [sent], [], replied), "");
});
