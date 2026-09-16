import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const compile = s => ts.transpileModule(s.replace(/^import\s[\s\S]*?;\s*$/gm, ''), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const runner = read('components/app-market/custom-app-runner.tsx');
const sent = [], callbacks = [], errors = [];
let receive;
const sdk = vm.createContext({ frameId: 'frame', appId: 'app', seq: 0, pending: {}, parent: { postMessage: m => sent.push(m) }, window: { addEventListener: (_type, fn) => { receive = fn; } }, console: { error: e => errors.push(e) } });
const requestSource = runner.slice(runner.indexOf('  function request(action,'), runner.indexOf('  function onEvent('));
const methods = ['generate', 'chat'].map(name => runner.match(new RegExp(`${name}: function\\(payload, handlers\\)\\{[^\\n]+`))[0]).join('\n');
vm.runInContext(requestSource + '\nglobalThis.ai = {' + methods + '\n};', sdk);
const msg = (id, data) => receive({ data: { source: 'ai-phone-custom-app-host', frameId: 'frame', requestId: id, ...data } });
const payload = Object.freeze({ instruction: 'task' });
const a = sdk.ai.generate(payload, { onChunk: x => callbacks.push(['A', x.text]) });
const b = sdk.ai.chat({ prompt: 'raw' }, { onChunk: x => callbacks.push(['B', x.text]) });
const [aid, bid] = sent.map(m => m.requestId);
assert.equal(sent[0].payload.stream, true); assert.equal(payload.stream, undefined);
msg(aid, { type: 'future.unknown' }); assert.ok(sdk.pending[aid]);
msg(bid, { type: 'stream.chunk', delta: 'B', text: 'B' });
msg(aid, { type: 'stream.chunk', delta: 'A', text: 'A' });
assert.ok(sdk.pending[aid]); assert.ok(sdk.pending[bid]);
msg(aid, { type: 'response', ok: true, result: { text: 'A' } });
msg(aid, { type: 'stream.chunk', delta: 'late', text: 'late' });
msg(bid, { type: 'response', ok: true, result: { text: 'B' } });
assert.equal((await a).text, 'A'); assert.equal((await b).text, 'B');
assert.deepEqual(callbacks, [['B', 'B'], ['A', 'A']]); assert.equal(Object.keys(sdk.pending).length, 0);
const plain = sdk.ai.generate(payload); assert.equal(JSON.stringify(sent.at(-1).payload), JSON.stringify(payload));
msg(sent.at(-1).requestId, { type: 'response', ok: true, result: { text: 'legacy' } }); assert.equal((await plain).text, 'legacy');
const broken = sdk.ai.chat({}, { onChunk: () => { throw new Error('app callback'); } });
const cid = sent.at(-1).requestId; msg(cid, { type: 'stream.chunk', delta: 'x', text: 'x' });
msg(cid, { type: 'response', ok: false, error: 'network' });
await assert.rejects(broken, /network/); assert.equal(errors.length, 1); assert.equal(Object.keys(sdk.pending).length, 0);
console.log('PASS actual SDK: optional handlers, unchanged plain payload, interleaved IDs, unknown message, cleanup and callback exceptions');

const bc = vm.createContext({});
const bridgeStart = runner.indexOf('function createCustomAppStreamBridge(');
const bridgeEnd = runner.indexOf('\n}\n', bridgeStart) + 3;
vm.runInContext(compile(runner.slice(bridgeStart, bridgeEnd)) + ';globalThis.create = createCustomAppStreamBridge;', bc);
for (const action of ['ai.generate', 'ai.chat']) {
  const events = [], bridge = bc.create(action, { stream: true }, c => events.push({ ...c }));
  bridge.onDelta('tool draft'); bridge.onDelta(' + reasoning'); bridge.finish({ text: 'final' });
  events.push({ type: 'response', text: 'final' }); bridge.onDelta('late');
  assert.equal(events.length, 4); assert.equal(events.at(-2).text, events.at(-1).text); assert.equal(events.at(-2).delta, '');
  const none = []; const closed = bc.create(action, { stream: true }, c => none.push(c)); closed.close(); closed.onDelta('late'); assert.equal(none.length, 0);
  const empty = []; bc.create(action, { stream: true }, c => empty.push(c)).finish({ text: '' }); assert.equal(empty[0].text, '');
}
assert.equal(bc.create('ai.chat', {}, () => { throw new Error(); }), undefined);
assert.equal(bc.create('db.list', { stream: true }, () => { throw new Error(); }), undefined);
console.log('PASS stream bridge: final correction precedes response; success/error stop late callbacks; opt-in only');

// Run host API bodies against callback-capable engines, retaining all existing response shapes.
const host = read('lib/custom-app-host-api.ts');
function hostFunction(name, globals) {
  const start = host.indexOf(`export async function ${name}(`), end = host.indexOf('\nexport ', start + 10);
  const c = vm.createContext({ exports: {}, console, ...globals }); vm.runInContext(compile(host.slice(start, end)), c); return c.exports[name];
}
const base = { cleanText: v => String(v || ''), cleanUnboundedText: v => String(v || ''), asRecord: v => v || {}, hasPermission: () => false, ensureCharacterSession: () => ({ id: 's', streamOnline: false }), resolvePromptProfile: () => null, normalizeCustomAppGenerateMessages: () => [], activeCustomAppWorldBookIds: () => [], readWorldActivations: () => [], buildCustomAppChatTags: () => [], flattenCompletionResult: () => 'final', serializeCustomAppContextMessage: m => m };
let sawStream;
const single = hostFunction('generateCustomAppText', { ...base, generateChatCompletion: async (session, _history, _opts, cb) => { sawStream = !!cb.onStreamDelta; if (sawStream) { assert.equal(session.streamOnline, true); cb.onStreamDelta('single'); } else assert.equal(session.streamOnline, false); return {}; } });
const deltas = [];
await single({ id: 'app', name: 'App' }, { characterId: 'c', stream: true }, d => deltas.push(d)); assert.equal(sawStream, true);
await single({ id: 'app', name: 'App' }, { characterId: 'c' }, () => { throw new Error(); }); assert.equal(sawStream, false);
const chat = hostFunction('runCustomAppAiChat', { ...base, resolveCustomAppApiConfig: () => ({}), optionalCustomAppTimeoutMs: () => undefined, withOptionalCustomAppTimeout: (_ms, _label, fn) => fn(undefined), simpleLLMCall: async (_config, _messages, opts) => { sawStream = !!opts.onDelta; opts.onDelta?.('chat'); return { content: 'final', finishReason: 'stop', wasTruncated: false }; } });
const result = await chat({}, { prompt: 'task', stream: true }, d => deltas.push(d));
assert.deepEqual(JSON.parse(JSON.stringify(result)), { text: 'final', finishReason: 'stop', wasTruncated: false });
await chat({}, { prompt: 'task' }); assert.equal(sawStream, false);
assert.deepEqual(deltas, ['single', 'chat']);
const groupSource = read('lib/group-chat-engine.ts');
const gs = groupSource.indexOf('export async function generateGroupRawCompletion('), ge = groupSource.indexOf('export type GroupOfflineChatCompletionResult', gs);
const gc = vm.createContext({ exports: {}, buildGroupChatPromptMessages: async () => ({ llmMessages: [], config: { defaultModel: 'model' }, preset: null, regexes: [] }), sendLLMRequest: async () => 'plain', sendLLMStreamRequest: async (...args) => { args.at(-1).onDelta('group'); return { content: 'final' }; } });
vm.runInContext(compile(groupSource.slice(gs, ge)), gc);
assert.equal((await gc.exports.generateGroupRawCompletion({ id: 's' }, [], { onStreamDelta: d => deltas.push(d) })).text, 'final');
assert.equal((await gc.exports.generateGroupRawCompletion({ id: 's' }, [], {})).text, 'plain');
assert.match(host.slice(host.indexOf('export async function generateCustomAppGroupText(')), /record\.stream === true && onDelta \? \{ onStreamDelta: onDelta \}/);
console.log('PASS host single/group/raw routing and legacy response shape');

// Actual provider parsers, real ReadableStream fragments, no external network.
const adapter = vm.createContext({ exports: {} }); vm.runInContext(compile(read('lib/llm-provider-adapter.ts')), adapter);
const parser = vm.createContext({ exports: {} }); vm.runInContext(compile(read('lib/sse-json.ts')), parser);
let request, response, apiLogs = [];
const helpers = vm.createContext({ exports: {}, console: { log() {}, warn() {} }, TextDecoder,
  fetch: async (url, opts) => { request = { url, ...opts }; return response; }, pushApiLog: log => apiLogs.push(log),
  require: name => name === './llm-provider-adapter' ? adapter.exports : name === './sse-json' ? parser.exports : (() => { throw new Error(name); })(),
});
vm.runInContext(compile(read('lib/api-helpers.ts')), helpers);
const config = { apiKey: 'synthetic-test-key', defaultModel: 'test-model' };
for (const [provider, records, finish] of [
  ['OpenAI', [{ choices: [{ delta: { content: '你' } }] }, { choices: [{ delta: { content: '好' }, finish_reason: 'length' }] }], 'length'],
  ['Anthropic', [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }], 'max_tokens'],
  ['Google', [{ candidates: [{ content: { parts: [{ text: '你' }] } }] }, { candidates: [{ content: { parts: [{ text: '好' }] }, finishReason: 'MAX_TOKENS' }] }], 'MAX_TOKENS'],
]) {
  const bytes = new TextEncoder().encode(records.map(r => `data: ${JSON.stringify(r)}\r\n\r\n`).join(''));
  response = new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const chunks = [];
  const r = await helpers.exports.simpleLLMCall({ ...config, provider }, [{ role: 'user', content: 'task' }], { onDelta: d => chunks.push(d) });
  assert.equal(r.content, '你好'); assert.equal(r.finishReason, finish); assert.equal(r.wasTruncated, true); assert.deepEqual(chunks, ['你', '好']);
  assert.ok(provider === 'Google' ? request.url.includes(':streamGenerateContent?alt=sse&') : JSON.parse(request.body).stream === true);
}
response = new Response(JSON.stringify({ choices: [{ message: { content: 'legacy' }, finish_reason: 'stop' }] }));
const legacy = await helpers.exports.simpleLLMCall({ ...config, provider: 'OpenAI' }, [{ role: 'user', content: 'task' }]);
assert.equal(legacy.content, 'legacy'); assert.equal(JSON.parse(request.body).stream, undefined);
assert.equal(apiLogs.length, 4);
console.log('PASS raw SSE: OpenAI/Anthropic/Gemini fragmented UTF-8, finish metadata, and unchanged nonstream JSON request');

response = new Response('data: '+JSON.stringify({choices:[{delta:{content:'<think>private</think>  visible  '},finish_reason:'stop'}]})+'\n\n', {headers:{'content-type':'text/event-stream'}});
const preview = [];
const cleaned = await helpers.exports.simpleLLMCall({...config, provider:'OpenAI'}, [{role:'user',content:'task'}], {onDelta:d=>preview.push(d)});
assert.equal(cleaned.content, 'visible'); assert.ok(preview.join('').includes('<think>'));
console.log('PASS streamed final text uses existing cleanup, allowing bridge reconciliation');
