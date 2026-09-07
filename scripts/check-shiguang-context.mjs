// 用真实宿主格式化器验证 APP 同文刷新，避免只 mock setContext 而漏掉过期行为。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as recall from "../custom-apps/shiguang/src/domain/recall.mjs";

const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
let now = new Date(2026, 8, 7, 10).getTime();
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const store = new Map();
const host = vm.createContext({
  Date: Clock, exports: {},
  require: id => {
    if (id === "./kv-db") return { kvGet: k => store.get(k), kvSet: (k, v) => store.set(k, v), registerKvMigration() {} };
    if (id === "./custom-app-storage") return { loadInstalledCustomApps: () => [{ id: "sg", name: "拾光", permissions: ["chat.context"] }] };
    throw new Error(id);
  },
});
vm.runInContext(ts.transpileModule(read("lib/custom-app-chat-context.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, host);
const settings = { enabled: true, tokenBudget: 800 };
const entry = { id: "m", title: "边界", promptSummary: "记得提前告知计划变更。", recallMode: "priority" };
const app = vm.createContext({
  Date: Clock, ShiguangRecall: recall,
  S: { entries: { c1: [entry] }, api: { chat: {
    setContext: async payload => host.exports.setCustomAppChatContext("sg", "拾光", payload),
  } } },
  loadSettings: async () => settings, recentMessages: async () => [],
});
vm.runInContext(read("custom-apps/shiguang/src/chat/context.js"), app);
const prompt = () => host.exports.formatCustomAppChatContextForPrompt("c1");
await app.syncContext("c1");
assert.match(prompt(), /记得提前告知计划变更/);
now += 7 * 60 * 60 * 1000;
assert.equal(prompt(), "", "宿主正常淘汰过期状态");
await app.syncContext("c1");
assert.match(prompt(), /记得提前告知计划变更/, "同文刷新后必须重新进入提示词");
now = new Date(2026, 8, 7, 23, 59).getTime();
await app.syncContext("c1");
now += 2 * 60 * 1000;
assert.equal(prompt(), "", "跨天旧状态失效");
await app.syncContext("c1");
assert.match(prompt(), /记得提前告知计划变更/, "跨天同文刷新后恢复注入");
assert.equal(host.exports.formatCustomAppChatContextForPrompt("c2"), "", "角色隔离");
settings.enabled = false;
await app.syncContext("c1");
assert.equal(prompt(), "", "关闭后撤销注入");
console.log("PASS 拾光同文刷新：6 小时过期、跨天、角色隔离、关闭撤销");
