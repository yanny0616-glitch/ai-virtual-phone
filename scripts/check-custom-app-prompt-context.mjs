// 当轮记忆：运行真实选取、装配和 APP provider；仅替换存储与 iframe 传输。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as recall from "../custom-apps/shiguang/src/domain/recall.mjs";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const load = (file, dependencies, globals = {}) => {
  const ctx = vm.createContext({ exports: {}, console, setTimeout, clearTimeout, ...globals, require: id => {
    if (id in dependencies) return dependencies[id];
    throw new Error(`unexpected import ${id}`);
  } });
  vm.runInContext(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return ctx.exports;
};
const apps = [{ id: "sg", name: "拾光", permissions: ["chat.context", "chat.read"], manifest: { extensions: { prompt: { contextProvider: { timeoutMs: 2000 } } } } }];
const store = new Map();
const storage = { loadInstalledCustomApps: () => apps };
const formatter = load("lib/custom-app-chat-context.ts", {
  "./kv-db": { kvGet: k => store.get(k), kvSet: (k, v) => store.set(k, v), registerKvMigration() {} },
  "./custom-app-storage": storage,
});
let invoke;
const service = load("lib/custom-app-prompt-context.ts", {
  "./custom-app-storage": storage,
  "./custom-app-tool-runtime": { invokeCustomAppContextProvider: (...args) => invoke(...args) },
});
const entry = { id: "x", title: "厦门之约", promptSummary: "约好十一一起去厦门看海。", keywords: ["厦门"], recallMode: "relevant" };
let enabled = true;
const app = vm.createContext({ ShiguangRecall: recall, SETTINGS_DEFAULT: { enabled: true, tokenBudget: 800 }, col: c => c,
  S: { api: { db: { list: async name => name === "settings" ? [{ enabled, tokenBudget: 800 }] : [{ ...entry, promptSummary: name + "：" + entry.promptSummary }] } } },
});
vm.runInContext(read("custom-apps/shiguang/src/chat/context.js"), app);
const input = (characterId = "c1", text = "还记得我们约好去厦门吗？") => ({ characterId, sessionId: "s-" + characterId, messages: [{ id: "u1", role: "user", content: text, createdAt: new Date().toISOString() }] });
invoke = (_app, request) => app.providePromptContext(request);
formatter.setCustomAppChatContext("sg", "拾光", { characterId: "c1", text: "旧话题：咖啡" });
const fresh = await service.prepareCustomAppPromptContexts(input());
const prompt = formatter.formatCustomAppChatContextForPrompt("c1", fresh);
assert.match(prompt, /厦门/);
assert.doesNotMatch(prompt, /咖啡/);
assert.match(formatter.formatCustomAppChatContextForPrompt("c1"), /咖啡/, "请求级结果不写共享状态");
assert.equal(formatter.formatCustomAppChatContextForPrompt("c1", await service.prepareCustomAppPromptContexts(input("c1", "咖啡"))), "", "无命中时清除本轮旧记忆");
enabled = false;
assert.equal(formatter.formatCustomAppChatContextForPrompt("c1", await service.prepareCustomAppPromptContexts(input())), "", "关闭后不读缓存启用状态");
enabled = true;
const [a, b] = await Promise.all([service.prepareCustomAppPromptContexts(input("c1")), service.prepareCustomAppPromptContexts(input("c2"))]);
assert.match(formatter.formatCustomAppChatContextForPrompt("c1", a), /c1：/);
assert.doesNotMatch(formatter.formatCustomAppChatContextForPrompt("c2", b), /c1：/);
let finish;
invoke = () => new Promise(resolve => { finish = resolve; });
apps[0].manifest.extensions.prompt.contextProvider.timeoutMs = 10;
const timedOut = await service.prepareCustomAppPromptContexts(input());
assert.equal(formatter.formatCustomAppChatContextForPrompt("c1", timedOut), "", "超时省略本轮旧记忆，聊天可继续");
finish("迟到结果");
await Promise.resolve();
assert.equal(formatter.formatCustomAppChatContextForPrompt("c1", timedOut), "", "迟到结果不能修改已经装配的请求");
invoke = async () => { throw new Error("provider failed"); };
assert.equal(formatter.formatCustomAppChatContextForPrompt("c1", await service.prepareCustomAppPromptContexts(input())), "");
apps[0].permissions = ["chat.context"];
invoke = () => { throw new Error("must not invoke without chat.read"); };
assert.equal(Object.keys(await service.prepareCustomAppPromptContexts(input())).length, 0);
apps[0].permissions = [];
assert.equal(formatter.formatCustomAppChatContextForPrompt("c1", fresh), "", "请求等待期间撤销权限后也不可注入");
console.log("PASS 当轮记忆：当前话题、空结果、关闭、角色隔离、超时、迟到、失败与撤权");

// 真实聊天装配中的入口和等待顺序；不触发实际模型或其他聊天功能。
apps[0].permissions = ["chat.context", "chat.read"];
apps[0].manifest.extensions.prompt.contextProvider.timeoutMs = 2000;
invoke = (_app, request) => app.providePromptContext(request);
const engine = read("lib/chat-engine.ts");
const start = engine.indexOf("    // 普通文字私聊：本次输入先召回");
const end = engine.indexOf("    const toolsPrompt =", start);
assert.ok(start > 0 && end > start && end < engine.indexOf("    const llmMessages = assemblePromptPayload({", start));
const scope = vm.createContext({
  exports: {}, prepareCustomAppPromptContexts: service.prepareCustomAppPromptContexts,
  formatCustomAppChatContextForPrompt: formatter.formatCustomAppChatContextForPrompt,
  formatReplyGateNoteForPrompt: () => "", stripStateAndInnerForPrompt: s => s,
});
vm.runInContext(ts.transpileModule(`export async function assemble(session, history, options = {}) {
  const character = { id: session.contactId }, resolvedAppId = options.appId || "chat", isOfflineMode = options.appTags?.includes("offline");
${engine.slice(start, end)}
  return customAppContext;
}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, scope);
const session = { id: "s1", contactId: "c1" };
assert.match(await scope.exports.assemble(session, input().messages, { appTags: ["chat", "text"] }), /厦门/);
for (const options of [{ appTags: ["text", "offline"] }, { appTags: ["text", "followup"] }, { appTags: ["text"], followUpCount: 1 }, { appTags: ["text"], appId: "custom_app:x" }, {}]) {
  assert.match(await scope.exports.assemble(session, input().messages, options), /咖啡/, "其他场景保留原路径");
}
assert.match(await scope.exports.assemble({ ...session, isGroup: true }, input().messages, { appTags: ["text"] }), /咖啡/);
console.log("PASS 聊天入口：当前消息在装配前召回，群聊/追发/线下/APP 调用保持原路径");

// 安装时不能把新 manifest 字段过滤掉。
const manifestStorage = load("lib/custom-app-storage.ts", {
  "./kv-db": { registerKvMigration() {}, registerDynamicPrefix() {} }, "./media-cache-storage": {},
});
const manifest = JSON.parse(read("custom-apps/shiguang/manifest.json"));
assert.equal(manifestStorage.normalizeCustomAppManifest(manifest).extensions.prompt.contextProvider.timeoutMs, 2000);
const toolsRuntime = load("lib/custom-app-tool-runtime.ts", {
  "./custom-app-storage": storage, "./custom-app-sdk-registry": {}, "./tool-storage": {},
});
let backgroundCalls = 0;
const stopBg = toolsRuntime.registerCustomAppBackgroundToolExecutor(async payload => {
  backgroundCalls++;
  assert.equal(payload.tool.id, "__prompt_context__");
  assert.equal(payload.context.characterId, payload.args.characterId);
  return app.providePromptContext(payload.args);
});
assert.match(await toolsRuntime.invokeCustomAppContextProvider(apps[0], input(), 2000), /厦门/);
assert.equal(backgroundCalls, 1);
const stopFg = toolsRuntime.registerCustomAppToolExecutor("sg", async () => "前台结果");
assert.equal(await toolsRuntime.invokeCustomAppContextProvider(apps[0], input(), 2000), "前台结果");
assert.equal(backgroundCalls, 1);
stopFg(); stopBg();
await assert.rejects(toolsRuntime.invokeCustomAppContextProvider(apps[0], input(), 2000), /未就绪/);
console.log("PASS manifest 保留声明，APP 开启/关闭分别使用前台/后台 handler");
