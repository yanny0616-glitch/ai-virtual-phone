import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const js = source => stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?;\s*$/gm, "").replace(/^export /gm, "");
function load(file, globals, names) {
    const context = vm.createContext({ console, ...globals });
    vm.runInContext(js(read(file)) + `\nglobalThis.api={${names}};`, context);
    return context.api;
}
const protocol = load("lib/chat-silence-protocol.ts", {}, "isChatSilenceResponse,stripChatSilenceMarker,createChatSilenceStreamFilter");
const state = load("lib/state-value-parser.ts", {}, "parseStateValues,mergeStateValues");
const expression = load("lib/voice-expression.ts", {}, "extractVoiceExpression");
const parser = load("lib/rich-message-parser.ts", { ...state, ...expression, stripActionShells: value => value,
    stripTextToolDirectives: value => value, loadCustomAppChatDirectives: () => [] }, "parseAIResponse");

const hooks = new Map(), pluginStore = new Map(), variables = new Map();
const session = { id: "s", contactId: "c" };
const plugin = vm.runInNewContext(read("chat-plugins/affection-ledger.js").replace("export default", "globalThis.plugin ="));
plugin.setup({ hooks: { transform: (point, fn) => hooks.set(point, fn), on() {} },
    data: { sessions: { get: () => session }, variables: { get: key => variables.get(key), set: (key, value) => variables.set(key, value) } },
    system: { settings: { get: () => undefined }, storage: { get: key => pluginStore.get(key), set: (key, value) => pluginStore.set(key, value), remove: key => pluginStore.delete(key) } },
    ui: { injectCSS() {}, slot() {}, toast() {} },
});
const raw = "[本轮不回复]\n[好感度:42][状态栏]签名：今天想安静一点。[/状态栏]\n[内心]其实我记得他说过的话。\n好感 +1|记得我的习惯[/内心]";
const transformed = hooks.get("llm.response")({ sessionId: "s", text: raw });
assert.equal(variables.get("affection").score, 11);
assert.ok(pluginStore.get("pending:s").thought.includes("记得"));
assert.ok(protocol.isChatSilenceResponse(transformed.text));

const storageSource = read("lib/chat-storage.ts");
const pick = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const records = [], effects = [];
let serial = 0;
const context = vm.createContext({ console, ...parser, ...protocol,
    _messagesCache: records, _sessionsCache: [], dbPutMessage() {}, loadChatSessions: () => [session],
    getNextMessageOrder: () => serial, createMessageId: () => `hidden-${++serial}`,
    runChatPluginTransformSync: (point, payload) => hooks.get(point)?.(payload) ?? payload,
    window: { dispatchEvent: () => effects.push("event") }, emitChatPluginEvent: () => effects.push("plugin event"),
    getChatPluginRuntime: () => ({ ensureReady: async () => {} }), createResponseBatchId: () => "batch",
    getLatestCharacterStateValues: () => [], isCustomStatusRegionActive: () => false, getStatusRegionConfig: () => ({}),
});
const storageFunctions = pick(storageSource, "export function getChatMessagePreview(", "function hasPreviewText(")
    + pick(storageSource, "function hasPreviewText(", "function getStableMessageOrder(")
    + pick(storageSource, "function isUnreadCandidate(", "function bumpSessionUnread(")
    + pick(storageSource, "function prepareChatMessage(", "/** 新消息批次的持久化屏障");
vm.runInContext(js(storageFunctions), context);
const followup = read("lib/follow-up-service.ts");
vm.runInContext(js(followup.slice(followup.indexOf("export async function parseAndSaveResponse(")))
    + "\nglobalThis.parse=parseAndSaveResponse;globalThis.preview=getChatMessagePreview;globalThis.candidate=isSessionPreviewCandidate;", context);
const result = await context.parse(transformed.text, "s", 0, undefined, [], { suppressReply: true, silent: true });
assert.equal(result.hasVisible, false);
assert.equal(records.length, 1);
assert.equal(records[0].silentUpdate, true);
assert.equal(records[0].content, "");
assert.equal(records[0].stateValues[0].value, 42);
assert.equal(records[0].statusPanel, "签名：今天想安静一点。");
assert.equal(context.preview(records[0]), "");
assert.equal(context.candidate(records[0]), false);
assert.deepEqual(effects, []);
assert.equal(pluginStore.has("pending:s"), false);
assert.ok(pluginStore.get(`m:${records[0].id}`).thought.includes("记得"));
hooks.get("message.beforePersist")({ message: { id: "next", role: "assistant", sessionId: "s", content: "下一条正常回复" } });
assert.equal(pluginStore.has("m:next"), false, "silent thought must not leak onto the next visible message");
await context.parse("[本轮不回复]\n[内心]内置内心仍按原字段保存。[/内心]", "s", 0, undefined, [], { suppressReply: true });
assert.equal(records[1].innerMonologue, "内置内心仍按原字段保存。");
assert.equal(context.preview(records[1]), "");
console.log("PASS actual affection plugin and metadata persistence: state/signature/inner updates retained, no preview/unread/events or next-message misattachment");

const room = read("components/chat/chat-room.tsx");
assert.match(room.slice(room.indexOf("const displayMessages ="), room.indexOf("const displayMessages =") + 220), /filter\(message => !message.silentUpdate\)/);
const shortTerm = read("lib/short-term-assembler.ts");
const hiddenCode = pick(shortTerm, "function isPromptHiddenChatMessage(", "\n}") + "\n}";
const hidden = vm.runInNewContext(js(hiddenCode) + "\nisPromptHiddenChatMessage;");
assert.equal(hidden(records[0]), true);
assert.match(read("lib/chat-engine.ts"), /history = history.filter\(message => !message.silentUpdate\)/);

// Execute the real worker's silence branch: retain metadata with an idempotent ID, never send a notification.
const worker = read("supabase/functions/push-generate/index.ts");
const start = worker.indexOf("    if (payload.allowSilence === true && isChatSilenceResponse(rawText");
assert.ok(start > 0);
const branch = worker.slice(start, worker.indexOf("    const abandoned =", start));
const outbox = new Map();
let notified = 0, finished = 0;
for (const text of [raw, raw, "[本轮不回复]"]) {
    await vm.runInNewContext(`(async()=>{${branch} notify();})()`, { ...protocol, CHAT_SILENCE_TOKEN: "[本轮不回复]", rawText: text, generationLease: null,
        payload: { allowSilence: true, merge: { sessionId: "s" }, generatedResponse: { createdAt: "2026-09-09T10:00:00Z" } },
        job: { id: "job", user_id: "u" }, finish: async () => { finished++; }, retry: async () => { throw Error("unexpected retry"); },
        rest: async (url, init) => { assert.equal(url, "push_outbox?on_conflict=id"); const row = JSON.parse(init.body)[0]; outbox.set(row.id, row); return { ok: true }; },
        notify: () => { notified++; },
    });
}
assert.equal(outbox.size, 1);
assert.equal([...outbox.values()][0].meta.silentUpdate, true);
assert.ok([...outbox.values()][0].raw_text.includes("签名"));
assert.equal(notified, 0);
assert.equal(finished, 3);
assert.match(read("lib/push-outbox-client.ts"), /suppressReply: meta.silentUpdate === true/);
console.log("PASS hidden updates excluded from UI/history; cloud metadata outbox is idempotent and skips notifications");
