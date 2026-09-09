import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), "utf8");
const modules = new Map();
const requests = [];
const stubs = {
    "./settings-storage": {},
    "./action-parser": { stripActionShells: value => value },
    "./text-tool-protocol": { stripTextToolDirectives: value => value },
    "./custom-app-chat-directives": { loadCustomAppChatDirectives: () => [] },
};
function load(name) {
    if (stubs[name]) return stubs[name];
    if (modules.has(name)) return modules.get(name);
    const loadedModule = { exports: {} };
    const code = ts.transpileModule(read(`lib/${name.replace(/^\.\//, "")}.ts`), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, {
        module: loadedModule, exports: loadedModule.exports, require: load, console, Blob, Response, AbortController, DOMException,
        setTimeout, clearTimeout,
        fetch: async (_url, init) => {
            requests.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ data: { audio: "494433" }, base_resp: { status_code: 0 } }));
        },
    });
    modules.set(name, loadedModule.exports);
    return loadedModule.exports;
}
const expression = load("./voice-expression");
const { buildVoiceExpressionPrompt, extractVoiceExpression, stripVoiceExpression, prepareVoiceExpression,
    resolveVoiceExpressionText, splitVoiceExpressionSegments } = expression;
const { parseAIResponse } = load("./rich-message-parser");
const { synthesizeChatSpeech, synthesizeSpeech } = load("./tts-service");
const config = { id: "voice", provider: "Minimax", model: "speech-2.8-hd", apiKey: "fixture", defaultVoice: "voice",
    speechExpressionEnabled: true, speechSpeed: 0.9, speechPitch: 1, languageBoost: "Chinese" };

assert.equal(buildVoiceExpressionPrompt(undefined, "chat"), "");
for (const patch of [{ speechExpressionEnabled: undefined }, { speechExpressionEnabled: false }, { provider: "OpenAI" }, { enableTTS: false }]) {
    assert.equal(buildVoiceExpressionPrompt({ ...config, ...patch }, "chat"), "");
}
assert.match(buildVoiceExpressionPrompt(config, "chat"), /不要因此把普通文字回复改成语音/);
assert.match(buildVoiceExpressionPrompt(config, "call"), /当前是语音通话/);
assert.match(buildVoiceExpressionPrompt({ ...config, model: "speech-02-hd" }, "call"), /禁止插入此类标签/);
assert.match(buildVoiceExpressionPrompt({ ...config, speechExpressionPrompt: "克制温柔" }, "chat"), /克制温柔/);
assert.match(buildVoiceExpressionPrompt({ ...config, speechExpressionPrompt: "  " }, "chat"), /避免播音腔/);

// Execute the actual injection branch, including the bound profile and excluded app contexts.
const engine = read("lib/chat-engine.ts");
const start = engine.indexOf('    const voiceConfig = loadVoiceConfigs().find(voice => voice.id === activeSlot.voiceConfigId);');
const branch = engine.slice(start, engine.indexOf("    const llmMessages = assemblePromptPayload", start)) + "\nglobalThis.result = voiceExpression;";
assert.ok(start > 0 && branch.includes("activeSlot.voiceConfigId"));
for (const [overrides, expected] of [[{}, 1], [{ effectiveAppTags: ["chat", "voice"] }, 1],
    [{ session: { isGroup: true } }, 0], [{ resolvedAppId: "custom" }, 0], [{ isOfflineMode: true }, 0],
    [{ promptProfile: { output: "json" } }, 0], [{ effectiveAppTags: ["chat", "video"] }, 0],
    [{ activeSlot: { voiceConfigId: "other" } }, 0]]) {
    const globals = { resolvedAppId: "chat", session: {}, isOfflineMode: false, promptProfile: undefined,
        effectiveAppTags: ["chat", "text"], activeSlot: { voiceConfigId: "voice" }, loadVoiceConfigs: () => [config],
        buildVoiceExpressionPrompt, llmMessages: [], ...overrides };
    vm.runInNewContext(branch, globals);
    assert.equal(Number(Boolean(globals.result)), expected);
}

const annotated = "<tts:happy>Welcome back!(chuckle)<#0.3#>I missed you.|欢迎回来！我想你了。";
const parsed = parseAIResponse(`[语音条:${annotated}]\n\n普通文字（认真）\n\n[内心]想念[/内心]`, []);
const voice = parsed.parts[0];
assert.equal(voice.mediaType, "audio");
assert.equal(voice.mediaData.label, "Welcome back!I missed you.|欢迎回来！我想你了。");
assert.equal(voice.mediaData.ttsText, annotated);
assert.equal(parsed.parts[1].content, "普通文字（认真）");
assert.equal(parsed.innerMonologue, "想念");
const speechText = resolveVoiceExpressionText(voice.mediaData.label, voice.mediaData.ttsText);
assert.equal(speechText, "<tts:happy>Welcome back!(chuckle)<#0.3#>I missed you.");
assert.equal(resolveVoiceExpressionText("已经编辑了", annotated), "已经编辑了");
assert.equal(resolveVoiceExpressionText("Hello|你好"), "Hello");
const multiline = "Hello|你好\nHow are you?|你好吗？";
assert.equal(resolveVoiceExpressionText(multiline), load("./bilingual-text").splitBilingualText(multiline)?.original || multiline);
assert.equal(resolveVoiceExpressionText(multiline, undefined, "call"), "Hello\nHow are you?");
assert.equal(extractVoiceExpression("示例 (chuckle)").ttsText, undefined);
assert.equal(parseAIResponse("[语音条:你好(chuckle)]", []).parts[0].mediaData.label, "你好");
assert.equal(parseAIResponse("[语音条:<tts:auto>(breath)]", []).parts.length, 0);
assert.equal(stripVoiceExpression("<tts:auto>你好（认真）"), "你好（认真）");

await synthesizeChatSpeech(speechText, config);
let request = requests.at(-1);
assert.equal(request.voice_setting.emotion, "happy");
assert.equal(request.voice_setting.speed, 0.9);
assert.equal(request.voice_setting.pitch, 1);
assert.equal(request.language_boost, "Chinese");
assert.equal(request.audio_setting.bitrate, 256000);
assert.equal(request.text, "Welcome back!(chuckle)<#0.3#>I missed you.");
for (const emotion of ["auto", "bogus", "fluent", "neutral"]) {
    await synthesizeChatSpeech(`<tts:${emotion}>你好`, config);
    assert.equal(requests.at(-1).voice_setting.emotion, undefined);
    assert.equal(requests.at(-1).text, "你好");
}
await synthesizeChatSpeech(speechText, { ...config, speechExpressionEnabled: false });
assert.equal(requests.at(-1).voice_setting.emotion, undefined);
assert.equal(requests.at(-1).text, "Welcome back!I missed you.");
await synthesizeChatSpeech(speechText, { ...config, model: "speech-02-hd" });
assert.equal(requests.at(-1).text, "Welcome back!<#0.3#>I missed you.");
await synthesizeChatSpeech(speechText, { ...config, provider: "OpenAI" });
assert.equal(requests.at(-1).input, "Welcome back!I missed you.");
assert.equal(requests.at(-1).voice_setting, undefined);
await synthesizeSpeech("(sighs)你好", config, { emotion: "sad" });
assert.equal(requests.at(-1).text, "(sighs)你好");
assert.equal(requests.at(-1).voice_setting.emotion, "sad");
const count = requests.length;
assert.equal(await synthesizeChatSpeech("<tts:auto>", config), null);
assert.equal(requests.length, count);
assert.equal(prepareVoiceExpression("<tts:calm><#0.2#>你好<#0.3#>(breath)<#0.4#>嗯<#500#>啊<#bad#>。<#0.1#>", config).text,
    "你好<#0.3#>(breath)嗯啊。");

// Call output stores clean history/subtitles and retains each segment's emotion for TTS.
const call = parseAIResponse("<tts:happy>你回来啦！(chuckle)\n\n<tts:calm>我在。<#0.3#>慢慢说。", []);
assert.equal(call.parts[0].content, "你回来啦！");
assert.equal(call.parts[1].content, "我在。慢慢说。");
const utterances = call.parts.flatMap(part => splitVoiceExpressionSegments(part.mediaData.ttsText));
for (const utterance of utterances) await synthesizeChatSpeech(resolveVoiceExpressionText(stripVoiceExpression(utterance), utterance), config);
assert.equal(requests.at(-2).voice_setting.emotion, "happy");
assert.equal(requests.at(-1).voice_setting.emotion, "calm");
assert.equal(splitVoiceExpressionSegments("<tts:happy>你好<tts:sad>再见").length, 2);
// Exercise the actual call playback loop: ending during synthesis/playback stops subsequent segments.
const callSource = read("components/chat/voice-call-screen.tsx");
const loopStart = callSource.indexOf("                    const segments = isVoiceExpressionEnabled");
const loop = callSource.slice(loopStart, callSource.indexOf("                } catch (e)", loopStart));
assert.ok(loopStart > 0);
for (const stopAt of ["none", "synthesis", "playback"]) {
    let synthesized = 0, played = 0;
    const stateRef = { current: "AI_SPEAKING" };
    await vm.runInNewContext(`(async () => {${loop}})()`, {
        ...expression, voiceConfig: config, cleanParts: utterances, stateRef, audioAbortRef: { current: null },
        synthesizeChatSpeech: async () => { synthesized++; if (stopAt === "synthesis") stateRef.current = "ENDED"; return {}; },
        playCallAudio: () => { played++; if (stopAt === "playback") stateRef.current = "ENDED"; return { promise: Promise.resolve(), abort() {} }; },
    });
    assert.equal(synthesized, stopAt === "none" ? 2 : 1);
    assert.equal(played, stopAt === "synthesis" ? 0 : stopAt === "none" ? 2 : 1);
}

// Actual chat in-flight cache and persistence: one synthesis per concurrent click, failure remains retryable.
const bubble = read("components/chat/message-bubble.tsx");
const cacheSource = bubble.slice(bubble.indexOf("const _voiceSynthInFlight ="), bubble.indexOf("function VoiceMessageBubble("))
    .replace('await import("@/lib/tts-service")', "ttsFixture")
    .replace('await import("@/lib/chat-storage")', "storageFixture");
let synthCount = 0, fail = false;
const saved = [];
const cacheContext = vm.createContext({
    ttsFixture: { resolveVoiceConfig: () => config, synthesizeChatSpeech: async () => { synthCount++; if (fail) throw Error("fixture failure"); return new Blob(["ID3"]); } },
    storageFixture: { persistMessageVoiceAudio: async (...args) => saved.push(args) },
    FileReader: class { readAsDataURL() { this.result = "data:audio/mpeg;base64,SUQz"; this.onload(); } },
});
vm.runInContext(ts.transpileModule(cacheSource + "\nglobalThis.run = synthesizeVoiceForMessage;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, cacheContext);
await Promise.all([cacheContext.run("message", "character", speechText), cacheContext.run("message", "character", speechText)]);
assert.equal(synthCount, 1);
assert.equal(saved.length, 1);
assert.equal(saved[0][2], speechText);
fail = true;
await assert.rejects(cacheContext.run("retry", "character", speechText));
await new Promise(resolve => setTimeout(resolve, 0));
fail = false;
await cacheContext.run("retry", "character", speechText);
assert.equal(saved.length, 2);
console.log("PASS configuration/scopes, rich parser, bilingual/edit handling, TTS request payloads, call cancellation, chat deduplication/persistence/retry, and SDK compatibility");
