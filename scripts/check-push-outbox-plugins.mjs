import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
function load(file, globals, expose) {
    let source = stripTypeScriptTypes(fs.readFileSync(new URL(file, root), "utf8"));
    source = source.replace(/^import\s[\s\S]*?;\s*$/gm, "")
        .replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g, "")
        .replace('await import("./reality-bridge/engine")', "bridgeEngine");
    const context = vm.createContext({ console, Date, Response, ...globals });
    vm.runInContext(source + "\nglobalThis.api = {" + expose + "};", context);
    return context.api;
}

function harness({ enabled = true, ready = Promise.resolve(), initial = {} } = {}) {
    const storage = new Map(), variables = new Map(), hooks = new Map(), saved = [];
    variables.set("c1affection", { score: 10, ...initial });
    const session = { id: "s1", contactId: "c1" };
    const state = { entries: [], transforms: 0, ackStatus: 200, started: false };
    const plugin = vm.runInNewContext(fs.readFileSync(new URL("chat-plugins/affection-ledger.js", root), "utf8")
        .replace("export default", "globalThis.plugin ="));
    const pluginContext = {
        hooks: { transform: (key, fn) => hooks.set(key, fn), on() {} },
        system: { settings: { get() {} }, storage: {
            get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key),
        } },
        data: { sessions: { get: id => id === session.id ? session : null }, variables: {
            get: (key, scope, cid) => variables.get(cid + key),
            set: (key, value, scope, cid) => variables.set(cid + key, value),
        } },
        ui: { injectCSS() {}, slot() {}, toast() {} },
    };
    const stateParser = load("lib/state-value-parser.ts", {}, "parseStateValues,mergeStateValues");
    const parser = load("lib/rich-message-parser.ts", {
        ...stateParser, stripActionShells: text => text, stripTextToolDirectives: text => text,
        loadCustomAppChatDirectives: () => [],
    }, "parseAIResponse");
    const client = load("lib/push-outbox-client.ts", {
        window: {}, isPersonalPushCloudActive: () => true, hasAccountPushSubscription: async () => true,
        loadScreenChatSettings: () => ({ enabled: false }),
        getChatPluginRuntime: () => ({ ensureStarted: async () => {
            await ready;
            if (!state.started && enabled) plugin.setup(pluginContext);
            state.started = true;
        } }),
        runChatPluginTransform: async (point, payload) => {
            assert.equal(state.started, true);
            assert.equal(point, "llm.response");
            state.transforms++;
            return hooks.get(point)?.(payload) ?? payload;
        },
        stripHallucinatedTimestamps: text => text,
        applyOutputRegex: text => {
            // 插件必须先于输出正则；否则正则可能吞掉插件的好感结算数据。
            if (enabled) assert.equal(text.includes("[内心]"), false);
            return text;
        },
        MacroEngine: class {}, getActiveAppTags: () => [],
        loadChatSessions: () => [session], loadChatMessages: () => saved,
        personalPushFetch: async (action, options) => {
            assert.equal(action, "outbox");
            return new Response(JSON.stringify(options ? { ok: state.ackStatus === 200 } : { ok: true, entries: state.entries }),
                { status: options ? state.ackStatus : 200 });
        },
        parseAndSaveResponse: async (text, sessionId, count, index, history, options) => {
            const parsed = parser.parseAIResponse(text, []);
            for (const part of parsed.parts) {
                const message = { id: "m" + saved.length, role: "assistant", sessionId,
                    content: part.content, innerMonologue: parsed.innerMonologue,
                    statusPanel: parsed.statusPanel, responseBatchId: options.responseBatchId };
                hooks.get("message.beforePersist")?.({ message });
                saved.push(message);
            }
            return { hasVisible: saved.length > 0, newCount: 10, stateValues: parsed.stateValues };
        },
        removeTimedWakeSchedule() {}, reindexSessionMessageOrdersByTime() {}, saveScreenChatAck() {},
        bridgeEngine: { applyServerBridgeEntry: async () => ({ sessionId: session.id }) },
    }, "consumeServerOutbox");
    return { state, storage, variables, saved, client };
}

function entry(id, meta = {}) {
    return { id, session_id: "s1", trigger_key: "timedwake:" + id,
        raw_text: "路过你喜欢的店。\n\n给你带了一份。\n\n[内心]想到你会喜欢。\n好感+0.5|想与你分享\n关系→朋友|本来就熟悉\n[/内心]",
        meta: { regexes: [{}], ...meta }, created_at: new Date().toISOString() };
}

for (const bridge of [false, true]) {
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    const h = harness({ ready });
    h.state.entries = [entry("one", bridge ? { kind: "bridge", reply: { sessionId: "s1", regexes: [{}] } } : {})];
    h.state.ackStatus = 503;
    const consuming = Promise.all([
        h.client.consumeServerOutbox({ force: true }),
        h.client.consumeServerOutbox({ force: true }),
    ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.transforms, 0, "等待插件启动后才能处理消息");
    release();
    await consuming;
    assert.equal(h.saved.length, 2);
    assert.ok(h.saved.every(message => !message.innerMonologue && !message.statusPanel));
    assert.equal(h.storage.get("m:m0").thought, "想到你会喜欢。");
    assert.equal(h.storage.get("m:m0").delta, 0.5);
    assert.equal(h.storage.has("m:m1"), false, "多气泡只结算一次");
    const score = h.variables.get("c1affection").score;
    h.state.ackStatus = 200;
    await h.client.consumeServerOutbox({ force: true });
    assert.equal(h.state.transforms, 1, "确认失败重拉时不能重复结算");
    assert.equal(h.saved.length, 2);
    assert.equal(h.variables.get("c1affection").score, score);
    console.log(`PASS ${bridge ? "bridge" : "timed wake"}: plugin readiness, affection, panel ownership, duplicate delivery`);
}

const native = harness({ enabled: false });
native.state.entries = [entry("native")];
await native.client.consumeServerOutbox({ force: true });
assert.ok(native.saved[0].innerMonologue.includes("想到你会喜欢"));
assert.equal(native.variables.get("c1affection").score, 10);
console.log("PASS disabled plugin: native parsing remains available");

const unknown = harness();
unknown.state.entries = [{ ...entry("unknown"), session_id: "missing" }];
await unknown.client.consumeServerOutbox({ force: true });
assert.equal(unknown.state.transforms, 0);
assert.equal(unknown.saved.length, 0);
console.log("PASS missing session: no plugin settlement");

for (const { line, initial, delta, status, score } of [
    { line: "好感 0|想平静地陪着", delta: 0, status: "unchanged", score: 10 },
    { line: "", delta: 0, status: "missing", score: 10 },
    { line: "好感度：＋0.5｜记得我的喜好", delta: 0.5, status: "applied", score: 10.5 },
    { line: "好感 −0.5|有点失落", delta: -0.5, status: "applied", score: 9.5 },
    { line: "好感+5|被打动了", delta: 3, status: "per-reply-cap", score: 13 },
    { line: "好感+0.5|想与你分享", initial: { todayDate: new Date().toISOString().slice(0, 10), todayDelta: 4 }, delta: 0, status: "daily-cap", score: 10 },
    { line: "好感+0.5|想与你分享", initial: { todayDate: new Date().toISOString().slice(0, 10), todayDelta: 3.8 }, delta: 0.2, status: "daily-cap", score: 10.2 },
    { line: "好感+0.5|想与你分享", initial: { score: 99.8 }, delta: 0.2, status: "score-limit", score: 100 },
    { line: "好感+0.5|想与你分享", initial: { score: 100 }, delta: 0, status: "score-limit", score: 100 },
]) {
    const h = harness({ initial });
    h.state.entries = [{ ...entry("settle"), raw_text: `带给你。\n\n[内心]想到你了。\n${line}\n[/内心]` }];
    await h.client.consumeServerOutbox({ force: true });
    const settled = h.storage.get("m:m0");
    assert.equal(settled.delta, delta, line);
    assert.equal(settled.changeStatus, status, line);
    assert.equal(h.variables.get("c1affection").score, score, line);
    if (initial?.score === 100) assert.equal(h.variables.get("c1affection").todayDelta, 0);
}
console.log("PASS affection settlement: zero, missing, alternate formats, daily/reply caps and score bounds (9 cases)");
