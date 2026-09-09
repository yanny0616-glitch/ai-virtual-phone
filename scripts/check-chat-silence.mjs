import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const js = s => stripTypeScriptTypes(s).replace(/^export /gm, '');
const protocol = vm.createContext({});
vm.runInContext(js(read('lib/chat-silence-protocol.ts')) + '\nglobalThis.api={isChatSilenceResponse,stripChatSilenceMarker,createChatSilenceStreamFilter};', protocol);
const { isChatSilenceResponse, stripChatSilenceMarker, createChatSilenceStreamFilter } = protocol.api;
for (const value of ['[本轮不回复]', ' \n[本轮不回复]\n', '<think>不想回应</think>[本轮不回复]', '<thought>先想想</thought>[本轮不回复]']) {
  assert.ok(isChatSilenceResponse(value, 'thought'));
  let visible = '';
  const f = createChatSilenceStreamFilter(text => { visible += text; }, 'thought');
  for (const char of value) await f.push(char);
  await f.flush();
  assert.equal(visible, '');
}
for (const value of ['', '……', '我不想回你', '标记是 [本轮不回复]', '[本轮不回复] 但我还是回了', '<think>思考</think>你好', '[本轮不回']) {
  assert.equal(isChatSilenceResponse(value), false);
  let visible = '';
  const f = createChatSilenceStreamFilter(text => { visible += text; });
  for (const char of value) await f.push(char);
  await f.flush();
  assert.equal(visible, value);
}
console.log('PASS exact decision, thought tags, split stream prefix and ordinary quoted text');

// Execute the actual plugin rules with controllable settings and current character state.
const hooks = new Map(), settings = {}, states = new Map();
const p = vm.createContext({});
vm.runInContext(read('chat-plugins/busy-reply.js').replace('export default', 'globalThis.plugin ='), p);
for (const field of p.plugin.manifest.settings) settings[field.key] = field.default;
p.plugin.setup({
  hooks: { transform: (name, fn) => hooks.set(name, fn) },
  data: { replyGate: { policyVersion: 1, silenceVersion: 1 }, characters: { list: () => [] }, variables: { get: name => states.get(name) } },
  system: { settings: { get: k => settings[k], all: () => ({ ...settings }), onChange() {} }, storage: { get: () => true } },
});
const prompt = (replyText = '你为什么不理我', extra = {}) => hooks.get('prompt.system')({ sessionId: 's', characterId: 'c', isGroup: false, hint: '', replyText, ...extra });
assert.equal(prompt().allowSilence, true);
assert.match(prompt().hint, /生气、不知如何回答、需要独处/);
states.set('affection', { relationship: '争执中' });
assert.match(prompt().hint, /争执中/);
assert.equal(prompt('我在医院\n嗯嗯').allowSilence, undefined); // Whole pending batch, not just its closing word.
settings.urgentBypass = false; assert.equal(prompt('快回').allowSilence, true);
settings.enabled = false; assert.equal(prompt().allowSilence, undefined);
settings.enabled = true; settings.allowSilence = false; assert.equal(prompt().allowSilence, undefined);
settings.allowSilence = true;
assert.equal(prompt('你好', { isGroup: true }).allowSilence, undefined);
assert.equal(prompt('你好', { replyText: undefined }).allowSilence, undefined);
console.log('PASS contextual plugin policy, switches, current relationship and urgent batch protection');

// Execute production completion loops, stubbing only the model, prompt assembly and side-effect dependencies.
const engine = read('lib/chat-engine.ts');
const native = engine.slice(engine.indexOf('async function generateNativeChatCompletion('), engine.indexOf('async function registerShortcutContinuation('));
const core = engine.slice(engine.indexOf('async function generateChatCompletionCore('), engine.indexOf('/**\n * Preview'));
assert.ok(native.length > 1000 && core.length > 1000);
async function completion({ output = '[本轮不回复]', stream = false, nativeTools = false, enabled = true, fail = false } = {}) {
  const visible = [], deltas = [], effects = [], updates = [];
  const request = async () => { if (fail) throw new Error('network down'); return output; };
  const streamRequest = async (...args) => { const text = await request(); for (const char of text) await args.at(-1).onDelta(char); return { content: text, toolCalls: [] }; };
  const context = vm.createContext({ console, isChatSilenceResponse, stripChatSilenceMarker, createChatSilenceStreamFilter,
    persistChatSilenceMetadata: async (_session, text) => { updates.push(stripChatSilenceMarker(text)); },
    buildChatPromptMessages: async () => ({ llmMessages: [], character: { id: 'c', name: '角色' }, config: {}, preset: {}, regexes: [], userIdentity: {}, toolsEnabled: nativeTools, allowSilence: enabled }),
    mergeAppTags: tags => tags, maybeAppendShortcutCapability() {}, isSessionStreamingEnabled: () => stream,
    getEnabledTools: () => nativeTools ? [{ source: 'rest', sourceId: 'test' }] : [], nativeToolProtocolForConfig: () => nativeTools,
    getMaxToolRounds: () => 2, throwIfAborted() {}, sendLLMRequest: request, sendLLMStreamRequest: streamRequest,
    sendLLMToolRequest: async () => ({ content: await request(), toolCalls: [] }), sendLLMToolStreamRequest: streamRequest,
    stripPresetTexts: text => text, parseActionTags: text => ({ cleanText: text, actions: [] }),
    parseToolFetches: () => [], parseToolCalls: () => ({ toolCalls: [] }), stripStateAndInnerForPrompt: text => text,
    incrementEventCounter: () => effects.push('memory'), maybeRunSummarization: async () => {},
    loadChatSessions: () => [], normalizeNativeExpandedToolSourceIds: () => [], buildNativeChatTools: () => ({ definitions: [] }),
    toLlmRequestMessages: x => x, isNativeSingleTool: () => true, nativeToolSourceKey: () => 'test',
  });
  vm.runInContext(js(native + core) + '\nglobalThis.core=generateChatCompletionCore;', context);
  const bailout = { shortcutHandles: [] };
  // A followup tag here skips arming unrelated cloud leases; allowSilence is the frozen prompt-builder result.
  const result = await context.core({ id: 's', contactId: 'c' }, [], { appTags: ['followup'] }, {
    onTextPart: text => visible.push(text), onStreamDelta: text => deltas.push(text),
  }, bailout);
  return { result, visible, deltas, effects, updates };
}
for (const nativeTools of [false, true]) for (const stream of [false, true]) {
  const silent = await completion({ nativeTools, stream });
  assert.equal(silent.result.silenced, true);
  assert.equal(silent.result.parts.length, 0); assert.equal(silent.visible.length, 0); assert.equal(silent.deltas.length, 0); assert.equal(silent.effects.length, 0);
  const withMetadata = await completion({ nativeTools, stream, output: '[本轮不回复]\n[好感度:42][内心]我记得这件事。[/内心]' });
  assert.equal(withMetadata.result.silenced, true);
  assert.equal(withMetadata.visible.length, 0); assert.equal(withMetadata.deltas.length, 0);
  assert.deepEqual(withMetadata.updates, ['[好感度:42][内心]我记得这件事。[/内心]']);
  const reply = await completion({ nativeTools, stream, output: '我还没想好怎么说。' });
  assert.notEqual(reply.result.silenced, true); assert.deepEqual(reply.visible, ['我还没想好怎么说。']);
  if (stream) assert.equal(reply.deltas.join(''), '我还没想好怎么说。');
  const disabled = await completion({ nativeTools, stream, enabled: false });
  assert.notEqual(disabled.result.silenced, true);
  await assert.rejects(completion({ nativeTools, stream, fail: true }), /network down/);
}
console.log('PASS actual text/native and streaming/nonstreaming completion loops; silence succeeds, network errors remain errors');
const room = read('components/chat/chat-room.tsx');
assert.ok(room.includes('last.id !== silencedUserId'));
assert.ok(room.includes('if (cr.silenced)'));
assert.ok(engine.includes('!isOfflineMode && !session.isGroup'));
assert.ok(engine.includes('!options?.promptProfile'));
console.log('PASS UI completion acknowledgement and non-chat scope guards');

// Ordinary reply leases carry the same explicit authorization; old clouds never get the marker prompt.
{
  const source = read('lib/push-bailout-client.ts');
  const arm = source.slice(source.indexOf('export async function armReplyBailout('), source.indexOf('async function deleteBailoutJob('));
  const posted = [], deleted = [];
  let supported = false;
  const c = vm.createContext({ console, Date, REPLY_BAILOUT_LEASE_MS: 90000,
    bailoutEnabled: () => true, hasAccountPushSubscription: async () => true,
    personalPushFetch: async () => ({ ok: true, json: async () => ({ silenceSupported: supported }) }),
    loadChatSessions: () => [{ id: 's', contactId: 'c' }],
    pushJobsFetch: async options => { posted.push(JSON.parse(options.body)); return { ok: true }; },
    startBailoutHeartbeat: () => () => {}, deleteBailoutJob: async key => deleted.push(key),
  });
  vm.runInContext(js(arm) + '\nglobalThis.arm=armReplyBailout;', c);
  const params = { sessionId: 's', characterName: '角色', regexes: [], request: { url: 'https://model.test/chat', headers: {}, body: {}, providerKind: 'openai-compatible' }, allowSilence: true };
  assert.equal(await c.arm(params), null); assert.equal(posted.length, 0);
  supported = true;
  const handle = await c.arm(params);
  assert.equal(posted[0].payload.allowSilence, true);
  handle.settle(); handle.settle(); assert.equal(deleted.length, 1);
}
console.log('PASS ordinary cloud lease capability, silence authorization and idempotent completion');
