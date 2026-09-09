// 拾光 APP 领域层测试：直接 import src/domain 的 ESM，不进浏览器、不调模型。
import assert from "node:assert/strict";
import { countRounds, sliceBatch } from "../custom-apps/shiguang/src/domain/rounds.mjs";
import { estimateTokens, hash, isValidDate } from "../custom-apps/shiguang/src/domain/text.mjs";
import { defaultSummary, promptText, selectForPrompt, contextText, recallMode } from "../custom-apps/shiguang/src/domain/recall.mjs";
import { selectCandidates, buildPrompt, parseResult, parseJsonObject, formatEvents } from "../custom-apps/shiguang/src/domain/extraction.mjs";
import { checkShiguangBuild } from "./build-shiguang.mjs";
import { readFileSync } from "node:fs";
import "./check-shiguang-context.mjs";
import "./check-custom-app-prompt-context.mjs";
import "./check-shiguang-recall.mjs";

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// 轮数：角色连发只算一轮，撤回和媒体不算
const msg = (i, role, content = "内容" + i) => ({ id: "m" + i, role, content, createdAt: `2026-09-05T20:${String(i).padStart(2, "0")}:00.000Z` });
eq(countRounds([msg(1, "user"), msg(2, "assistant"), msg(3, "assistant"), msg(4, "user"), msg(5, "assistant"), { ...msg(6, "assistant"), isRetracted: true }]), 2, "rounds");
eq(countRounds([msg(1, "assistant"), msg(2, "assistant")]), 0, "no user turn, no round");
const long = [msg(1, "user", "a".repeat(20000)), msg(2, "assistant", "b".repeat(6000)), msg(3, "user", "c"), msg(4, "assistant", "d")];
eq(sliceBatch(long).length, 2, "batch cuts before the next user turn, never between question and answer");
eq(sliceBatch(long.slice(2)).length, 2, "small batch whole");

// 文本
eq(estimateTokens("你好世界abcd"), Math.ceil(4 / 1.5 + 4 / 4), "token formula matches host");
ok(hash("a") !== hash("b") && hash("a") === hash("a"), "hash stable");
ok(isValidDate("2026-09-12") && !isValidDate("2026-02-30") && !isValidDate("9/12"), "date validation");

// 回忆
const base = { id: "e1", characterId: "c1", title: "月光与画画", summary: "画不下去时循环听《月光》。", categories: ["共同经历"], reason: "深夜睡不着", story: "分享了《月光》", details: [{ label: "音乐", value: "《月光》" }], significance: "", promptSummary: "", recallMode: "relevant", keywords: ["月光", "画画"], status: "remembered", followup: "", updatedAt: "2026-09-01T00:00:00.000Z", lastEventAt: "2026-09-01T00:00:00.000Z" };
ok(defaultSummary(base).startsWith("月光与画画；画不下去时循环听《月光》。"), "default summary joins facts");
eq(defaultSummary({ ...base, legacy: { recallSummary: "紧凑摘要", stableSummary: "" } }), "紧凑摘要", "legacy compact summary wins over joined facts");
eq(promptText({ ...base, promptSummary: "摘要", status: "pending", followup: "改到周日" }), "摘要 当前进展：尚待兑现。 最新进展：改到周日", "prompt text");
eq(recallMode({ ...base, recallMode: undefined }), "relevant", "mode default");

const pin = i => ({ ...base, id: "p" + i, title: "边界" + i, promptSummary: "x".repeat(150) + i, recallMode: "priority", keywords: [] });
const hit = { ...base, id: "hit", title: "看展", promptSummary: "周六去美术馆看莫奈", keywords: ["莫奈", "美术馆"] };
const cold = { ...base, id: "cold", title: "无关", promptSummary: "无关内容", keywords: ["咖啡"] };
const off = { ...hit, id: "off", recallMode: "off" };
const gone = { ...hit, id: "gone", deletedAt: "2026-09-02T00:00:00.000Z" };
const picked = selectForPrompt([pin(1), pin(2), pin(3), pin(4), pin(5), pin(6), hit, cold, off, gone], "明天去美术馆看莫奈吗", 400);
ok(picked.some(p => p.entry.id === "hit"), "topic hit gets in even with many pinned records");
ok(!picked.some(p => ["cold", "off", "gone"].includes(p.entry.id)), "cold, off and deleted stay out");
const pinnedTokens = picked.filter(p => p.entry.id.startsWith("p")).reduce((s, p) => s + p.tokens, 0);
ok(pinnedTokens <= 400 && picked.reduce((s, p) => s + p.tokens, 0) <= 400, "within budget");
ok(picked.filter(p => p.entry.id.startsWith("p")).length >= 2, "leftover budget goes back to pinned records");
const due = { ...cold, id: "due", status: "pending", dueAt: "2026-09-06" };
ok(selectForPrompt([due], "随便聊聊", 800, new Date("2026-09-05T10:00:00")).length === 1, "upcoming promise is timely");
ok(selectForPrompt([due], "随便聊聊", 800, new Date("2026-09-20T10:00:00")).length === 0, "old promise is not timely");
eq(selectForPrompt([hit, { ...hit, id: "dup" }], "莫奈", 800).length, 1, "identical text deduplicated");
ok(contextText(picked).split("\n").every(line => line.startsWith("· ")) && contextText(picked).length <= 3900, "context lines");

// 整理
const sources = [msg(1, "user", "我们9月12日去海边，改计划请提前告诉我。"), msg(2, "assistant", "好，9月11日晚确认。")];
const events = formatEvents(sources, "沈烬言");
ok(events.includes("[s1]") && events.includes("沈烬言："), "events format");
const prompt = buildPrompt("沈烬言", events, [hit]);
ok(prompt.includes('"id":"hit"') && prompt.includes("promptSummary") && !prompt.includes("stableSummary"), "prompt carries candidates, new schema");
eq(selectCandidates([cold, hit], "莫奈 美术馆")[0].id, "hit", "candidates ranked by overlap");
const raw = "```json\n" + JSON.stringify({ memories: [{ existingId: "", title: "海边之约", summary: "9月12日去海边", categories: ["约定与承诺"], reason: "", story: "约好去海边", details: [{ label: "日期", value: "9月12日" }], significance: "", promptSummary: "9月12日去海边，11日晚确认。", pinned: false, keywords: ["海边"], dueAt: "2026-09-12", status: "pending", followup: "", sourceIds: ["s1", "s2"] }] }).replace(/\]}\]}$/, "],},]}") + "\n```";
const [entry] = parseResult(raw, sources, [], "c1", "2026-09-05T21:00:00.000Z");
ok(entry.id.startsWith("sg_") && entry.id.length < 40, "short stable id");
eq(entry.sourceIds, ["m1", "m2"], "source ids resolved");
eq([entry.dueAt, entry.recallMode, entry.firstEventAt], ["2026-09-12", "relevant", sources[0].createdAt], "fields");
const again = parseResult(raw, sources, [], "c1", "2026-09-05T22:00:00.000Z");
eq(again[0].id, entry.id, "same sources + title → same id (idempotent retry)");
assert.throws(() => parseResult(raw.replace('"s2"', '"s9"'), sources, [], "c1", "now"), /引用/, "bad source ref rejected");
assert.throws(() => parseResult('{"memories":[{"title":"x","sourceIds":["s1"],"categories":["不存在"],"details":[],"status":"remembered","summary":"y"}]}', sources, [], "c1", "now"), /类型/, "bad category rejected");
assert.throws(() => parseJsonObject("不是 json"), /不完整/, "garbage rejected"); checks += 3;
const locked = { ...entry, userEdited: true, promptSummary: "用户写的", updatedAt: "2026-09-05T21:30:00.000Z" };
const upd = parseResult(JSON.stringify({ memories: [{ existingId: entry.id, title: "海边之约", summary: "改了", categories: ["约定与承诺"], details: [], promptSummary: "模型重写", pinned: true, keywords: [], dueAt: "", status: "completed", followup: "已经去过了", sourceIds: ["s2"] }] }), sources, [locked], "c1", "2026-09-06T00:00:00.000Z");
eq([upd[0].promptSummary, upd[0].status, upd[0].followup, upd[0].baseUpdatedAt], ["用户写的", "completed", "已经去过了", locked.updatedAt], "locked record keeps user text, takes progress only");
eq(parseResult(JSON.stringify({ memories: [{ title: "海边之约", summary: "重建", categories: ["约定与承诺"], details: [], keywords: [], status: "remembered", sourceIds: ["s1"] }] }), sources, [{ ...entry, deletedAt: "x" }], "c1", "now").length, 0, "deleted title is not rebuilt");

// 安装包与产物
await checkShiguangBuild(); checks++;
const manifest = JSON.parse(readFileSync(new URL("../custom-apps/shiguang/manifest.json", import.meta.url), "utf8"));
ok(["app.data.read", "app.data.write", "chat.read.background", "chat.context", "ai.chat"].every(p => manifest.permissions.includes(p)), "manifest permissions");
ok(manifest.extensions.events[0].background === true, "background event declared");
console.log(`PASS 拾光 APP 领域层 ${checks} 项`);
