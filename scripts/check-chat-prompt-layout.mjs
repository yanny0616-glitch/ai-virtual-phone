import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const compile = source => ts.transpileModule(source.replace(/^import\s[\s\S]*?;\s*$/gm, ""), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(file, globals = {}) {
    const context = vm.createContext({ exports: {}, console, ...globals });
    vm.runInContext(compile(read(file)), context);
    return context.exports;
}
const time = { buildCharacterTimeContext: () => ({}), getSystemTimeZone: () => "UTC",
    getPromptTimestampOptionsForTimeContext: () => ({}), resolvePromptTimeAware: value => value };
const macro = load("lib/macro-engine.ts", time);
const expression = load("lib/voice-expression.ts");
const factory = load("lib/builtin-preset.ts", { getCheckPhonePromptTags: () => [] }).createBuiltinPreset();
const { assemblePromptPayload } = load("lib/llm-prompt-assembler.ts", {
    ...macro, ...time, matchesActiveTags: (tags, active) => !tags?.length || tags.every(tag => active.includes(tag)),
    stripStateAndInnerForPrompt: value => value,
});
const voice = { id: "voice", provider: "Minimax", model: "speech-2.8-hd", speechExpressionEnabled: true };
const ids = ["shortTermMemory", "chat_output_format", "chat_voice_format"];
const base = { ...factory, id: "preset", prompts: factory.prompts.filter(p => ids.includes(p.identifier)),
    prompt_order: ids.map(identifier => ({ identifier, enabled: true })) };
const old = { ...base, voiceExpressionVersion: undefined,
    prompts: base.prompts.map(p => ({ ...p, content: p.content.replace(/\{\{voiceExpression\}\}/g, "") + "\n我的自定义内容", enabled: false })) };
const before = JSON.stringify(old);
const upgraded = expression.migrateVoiceExpressionPreset(old);
assert.equal(JSON.stringify(old), before, "migration must not mutate input");
assert.equal(upgraded.prompt_order, old.prompt_order);
assert.equal(upgraded.prompts[0], old.prompts[0]);
for (const p of upgraded.prompts.filter(p => p.identifier !== "shortTermMemory")) {
    assert.equal(p.enabled, false);
    assert.ok(p.content.endsWith("我的自定义内容"));
    assert.equal((p.content.match(/\{\{voiceExpression\}\}/g) || []).length, 1);
}
assert.equal(expression.migrateVoiceExpressionPreset(upgraded), upgraded);
const missing = { ...old, prompts: [] };
assert.equal(expression.migrateVoiceExpressionPreset(missing).prompts.length, 0);
const removed = { ...upgraded, prompts: upgraded.prompts.map(p => ({ ...p, content: p.content.replace(/\{\{voiceExpression\}\}/g, "") })) };
assert.equal(expression.migrateVoiceExpressionPreset(removed), removed, "do not restore user-removed macros");

const history = [{ id: "user", role: "user", content: "用户的问题", createdAt: "2026-09-09T10:00:00Z" }];
const input = { character: { id: "c", name: "角色" }, history, preset: base, worldBooks: [], regexes: [], timeAware: false };
for (const mode of ["chat", "call"]) {
    const enabled = assemblePromptPayload({ ...input, appTags: ["chat", mode === "chat" ? "text" : "voice"],
        voiceExpression: expression.buildVoiceExpressionPrompt(voice, mode) });
    const entry = enabled.find(m => m.marker === (mode === "chat" ? "▸ 文字聊天输出格式" : "▸ 语音通话输出格式"))
        || enabled.find(m => m.content.includes("【语音表达协议】"));
    assert.ok(entry);
    assert.equal(enabled.filter(m => m.content.includes("【语音表达协议】")).length, 1);
    if (mode === "call") assert.ok(entry.content.indexOf("【语音表达协议】") < entry.content.indexOf("</voice_call_format>"));
    if (mode === "chat") {
        assert.ok(entry.content.indexOf("【语音表达协议】") > entry.content.indexOf("### 语音条"));
        assert.ok(entry.content.indexOf("【语音表达协议】") < entry.content.indexOf("### 发起语音通话"));
    } else assert.doesNotMatch(entry.content, /段间空一行|变化时另起一段/);
    const disabled = assemblePromptPayload({ ...input, appTags: ["chat", mode === "chat" ? "text" : "voice"] });
    assert.doesNotMatch(JSON.stringify(disabled), /voiceExpression|语音表达协议/);
    const hidden = assemblePromptPayload({ ...input, appTags: ["chat", mode === "chat" ? "text" : "voice"],
        voiceExpression: "SHOULD_NOT_APPEAR", preset: { ...base, prompt_order: base.prompt_order.map(p => ({ ...p, enabled: p.identifier === "shortTermMemory" })) } });
    assert.doesNotMatch(JSON.stringify(hidden), /SHOULD_NOT_APPEAR/);
}
console.log("PASS preset migration preserves edits/order/disabled entries; actual assembler places voice rules inside existing format entries");

const engine = read("lib/chat-engine.ts");
const section = (start, end) => {
    const index = engine.indexOf(start);
    assert.ok(index >= 0, start);
    const finish = end ? engine.indexOf(end, index) : engine.length;
    assert.ok(finish > index);
    return engine.slice(index, finish);
};
const guardContext = vm.createContext({ exports: {}, console });
vm.runInContext(compile(section("const EMPTY_GENERATE_CONTINUATION_PROMPT", "/** 日志分流")
    + section("export function appendEmptyGenerateGuardMessage", "export function publishDebugPromptSnapshot")), guardContext);
const guard = guardContext.exports.appendEmptyGenerateGuardMessage;
for (const [last, intent, expected] of [
    [history[0], undefined, 0], [{ role: "assistant", content: "第一条回答" }, undefined, 1],
    [{ role: "assistant", content: "第一条回答" }, "regenerate", 0],
    [{ role: "system", content: "状态" }, "regenerate", 0],
    [{ role: "tool", content: "工具结果", mediaType: "tool_result" }, undefined, 0],
]) {
    const messages = [];
    guard(messages, { preventEmptyGenerateRambling: true }, [history[0], last], intent);
    assert.equal(messages.length, expected);
}

// Actual long-press handler retains earlier messages, deletes the selected suffix, and marks regeneration.
const room = read("components/chat/chat-room.tsx");
const handler = room.slice(room.indexOf("    const handleRetry = async"), room.indexOf("    const handleRetractMessage"));
let options, deleted;
const retryContext = vm.createContext({ messages: [...history, { id: "a1", role: "assistant", content: "回答一" }, { id: "a2", role: "assistant", content: "回答二" }],
    session: { id: "s" }, deleteChatMessagesFrom: id => { deleted = id; }, setMessages() {}, setActiveMessageId() {}, cancelFollowUp() {},
    triggerReply() {}, runManagedGeneration: async value => { options = value; } });
vm.runInContext(compile(handler + "\nglobalThis.retry = handleRetry;"), retryContext);
await retryContext.retry("a2");
assert.equal(deleted, "a2");
assert.equal(options.history.length, 2);
assert.equal(options.history[0].content, "用户的问题");
assert.equal(options.generationIntent, "regenerate");
const guarded = [];
guard(guarded, { preventEmptyGenerateRambling: true }, options.history, options.generationIntent);
assert.equal(guarded.length, 0);
assert.match(room.slice(room.indexOf("const runManagedGeneration"), room.indexOf("const handleRetry")), /generateChatCompletion\([\s\S]*?generationIntent/);
console.log("PASS actual long-press retry + continuation guard: retrying a later bubble is not an empty continuation");

// Real manual-preview functions apply the same llm.request transform as sending; no network is called.
const previewSource = section("async function applyChatPluginLlmRequest", "async function ensureChatPromptPluginsReady")
    + section("export async function previewPromptPayload(", null);
for (const native of [false, true]) {
    let transforms = 0;
    const previewContext = vm.createContext({ exports: {}, window: {}, console,
        buildChatPromptMessages: async () => ({ llmMessages: [{ role: "system", content: "预设内容" }], character: { id: "c", name: "角色" },
            config: {}, preset: { name: "预设" }, userIdentity: { name: "用户" }, toolsEnabled: native }),
        runChatPluginTransform: async (point, payload) => {
            assert.equal(point, "llm.request"); assert.equal(payload.sessionId, "s"); assert.equal(payload.purpose, "chat"); transforms++;
            return { ...payload, messages: [...payload.messages, { role: "system", content: "插件在请求前补充的内容" }], temperature: 0.3 };
        },
        toLlmRequestMessages: value => value, getEnabledTools: () => native ? [{}] : [], nativeToolProtocolForConfig: () => native,
        loadChatSessions: () => [], normalizeNativeExpandedToolSourceIds: () => [], buildNativeChatTools: () => ({ definitions: [] }),
        buildProviderRequest: (_config, preset, messages) => ({ preset, messages }),
        publishDebugPromptSnapshot: value => value.request,
        previewMessagesForApi: (_config, preset, messages) => { assert.equal(preset.temperature, 0.3); return messages; },
    });
    vm.runInContext(compile(previewSource), previewContext);
    const snapshot = await previewContext.exports.previewPromptRequestSnapshot({ id: "s" }, history, { appTags: ["chat", "text"] });
    assert.equal(snapshot.preset.temperature, 0.3);
    assert.equal(snapshot.messages.at(-1).content, "插件在请求前补充的内容");
    const payload = await previewContext.exports.previewPromptPayload({ id: "s" }, history, { appTags: ["chat", "text"] });
    assert.equal(payload.messages.at(-1).content, "插件在请求前补充的内容");
    assert.equal(transforms, 2);
}

const tail = section("    const allowSilence = silenceEligible && pluginPrompt.allowSilence === true;", "    return { llmMessages, character, config, preset, regexes, userIdentity, toolsEnabled, allowSilence }");
for (const allowed of [true, false]) {
    const context = { silenceEligible: true, pluginPrompt: { allowSilence: allowed }, CHAT_SILENCE_TOKEN: "[本轮不回复]",
        llmMessages: [{ role: "system", content: "预设" }, { role: "user", content: "问题" }] };
    vm.runInNewContext(tail, context);
    assert.equal(context.llmMessages.length, allowed ? 3 : 2);
    assert.equal(context.llmMessages[0].content, "预设");
    if (allowed) assert.equal(context.llmMessages[1].marker, "沉默输出规则");
    assert.equal(context.llmMessages.at(-1).content, "问题");
}
const build = section("export async function buildChatPromptMessages(", "export type ChatCompletionCallbacks");
assert.ok(build.indexOf("await ensureChatPromptPluginsReady()") < build.indexOf('runChatPluginTransform("prompt.system"'));
assert.doesNotMatch(build, /llmMessages\.push\(\{ role: "system", content: voicePrompt/);
assert.match(build, /appendEmptyGenerateGuardMessage\(llmMessages, config, historyForPrompt, options\?\.generationIntent\)/);
console.log("PASS plugin preview hooks for normal/native requests, silence prefix placement, and plugin readiness ordering");
