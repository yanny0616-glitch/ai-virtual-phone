import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, mocks, extra = '', globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(read(file) + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, console, AbortController,
    require: id => {
      assert.ok(id in mocks, `Unexpected dependency ${id}`);
      return mocks[id];
    },
    ...globals,
  });
  return module.exports;
}

const pkg = { id: 'editing_pack', label: '读取预览撤销套件' };
// Exercise actual native mapping, including repeated names and text fallbacks.
const engine = load('lib/mascot-engine.ts', {
  './settings-storage': {}, './mascot-settings': {}, './tool-executor': {},
  './llm-provider-adapter': {}, './chat-engine': {},
  './mascot-tools': { MASCOT_TOOL_PACKAGES: [pkg] },
}, '\nexport { mapMascotNativeCalls, mergeMascotToolRequests };');
const nameMap = new Map([
  ['mascot_load_editing_pack', '_loader:editing_pack'],
  ['mascot_read_edit_object', '读取编辑对象'],
]);
const done = { reply: ['请查看结果'], rawAssistant: '请查看结果', protocol: 'text', toolCalls: [], toolFetches: [] };
const action = { name: '读取编辑对象', args: { scope: 'desktop' } };
function nativeResponse(calls, text = { toolFetches: [], toolCalls: [] }) {
  return { ...done, reply: [], rawAssistant: '', protocol: 'native',
    ...engine.mergeMascotToolRequests(engine.mapMascotNativeCalls(calls, nameMap), text), nativeToolCalls: calls };
}
async function run(respond, { success = true, panelOpen = false, stopAfterTool = false, stopBeforeResponse = false, stopOnPaint = false, abortDuringRequest = false } = {}) {
  const events = [], executed = [], histories = [];
  let rounds = 0;
  const store = load('lib/mascot-chat-store.ts', {
    './mascot-context': { getMascotContext: () => ({ page: 'desktop', fields: {} }) },
    './mascot-events': { mascotFillField: () => {} },
    './mascot-prompts': { PAGE_GREETINGS: {} },
    './mascot-state': { isMascotPanelOpen: () => panelOpen },
    './mascot-engine': { mascotChatWithTools: async (_, history, __, options) => {
      histories.push(plain(history));
      if (abortDuringRequest) {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })));
          store.stopMascotGeneration();
        });
      }
      const response = respond(rounds++);
      if (stopBeforeResponse) store.stopMascotGeneration();
      return response;
    } },
    './mascot-tools': {
      loadExpandedPackages: () => [], saveExpandedPackages: () => {}, clearExpandedPackages: () => {},
      touchExpandedPackage: (ids, id) => [...new Set([...ids, id])],
      findPackageByLabel: label => label === pkg.label ? pkg : undefined,
      buildMascotPackageSchemaPrompt: () => '读取动作定义',
      executeMascotToolCall: async (call, ctx) => {
        executed.push({ call: plain(call), ctx });
        if (stopAfterTool) store.stopMascotGeneration();
        return { name: call.name, success, data: success ? '读取成功' : undefined, error: success ? undefined : '模拟读取失败' };
      },
    },
  }, '', {
    window: { dispatchEvent: e => events.push(e) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    requestAnimationFrame: callback => { if (stopOnPaint) store.stopMascotGeneration(); callback(); },
  });
  await store.sendMascotMessage({ text: '整理桌面' });
  assert.equal(store.getMascotChatSnapshot().isThinking, false);
  return { rounds, executed, histories, messages: plain(store.getMascotChatSnapshot().messages),
    notices: events.filter(e => e.type === 'global-notice').map(e => e.detail) };
}

const calls = [
  { id: 'load-1', name: 'mascot_load_editing_pack', args: {} },
  { id: 'read-1', name: 'mascot_read_edit_object', args: { scope: 'desktop' } },
  { id: 'load-2', name: 'mascot_load_editing_pack', args: {} },
  { id: 'read-2', name: 'mascot_read_edit_object', args: { scope: 'character', id: 'a' } },
];
// A duplicate loader text echo is removed; a distinct text action is retained.
const extraAction = { name: action.name, args: { scope: 'appearance' } };
const mixed = nativeResponse(calls, { toolFetches: [{ name: pkg.label }], toolCalls: [extraAction] });
const result = await run(round => round === 0 ? mixed : done);
assert.equal(result.executed.length, 3, 'same-round actions must all execute');
assert.equal(result.rounds, 2);
assert.deepEqual(result.executed.map(e => e.call.args), [calls[1].args, calls[3].args, extraAction.args]);
assert.ok(result.executed.every(e => e.ctx === result.executed[0].ctx), 'task context must be shared');
const replay = result.histories[1];
for (const call of calls) {
  const responses = replay.filter(m => m.role === 'tool' && m.toolCallId === call.id);
  assert.equal(responses.length, 1, `exactly one result for ${call.id}`);
  assert.equal(responses[0].toolName, call.name);
}
assert.equal(replay.filter(m => m.role === 'tool' && !m.toolCallId).length, 1, 'text directives must not steal native IDs');

const textMixed = await run(round => round === 0
  ? { ...done, toolFetches: [{ name: pkg.label }], toolCalls: [action] } : done);
assert.equal(textMixed.executed.length, 1);
const loaderOnly = await run(round => round === 0 ? nativeResponse([calls[0]]) : done);
assert.equal(loaderOnly.rounds, 2, 'loader-only round must continue');
assert.equal(loaderOnly.executed.length, 0);
const actionOnly = await run(round => round === 0 ? nativeResponse([calls[1]]) : done);
assert.equal(actionOnly.histories[1].find(m => m.toolCallId)?.toolCallId, 'read-1');
console.log('PASS native/text loops: mixed loader/action, duplicate names, exact result IDs, task context, loader-only and action-only rounds.');

const echoResponse = nativeResponse([calls[1]], { toolFetches: [], toolCalls: [action] });
const echoed = await run(round => round === 0 ? echoResponse : done);
assert.equal(echoed.executed.length, 1, 'native/text echo must execute once');
const nestedNative = [{ name: '测试动作', args: { patch: { b: [1, 2], a: true }, id: 'a' } }];
const nestedText = [{ name: '测试动作', args: { id: 'a', patch: { a: true, b: [1, 2] } } }];
assert.equal(engine.mergeMascotToolRequests({ toolFetches: [], toolCalls: nestedNative }, { toolFetches: [], toolCalls: nestedText }).toolCalls.length, 1, 'object key order does not distinguish identical args');
const orderedText = [{ name: '测试动作', args: { id: 'a', patch: { a: true, b: [2, 1] } } }];
assert.equal(engine.mergeMascotToolRequests({ toolFetches: [], toolCalls: nestedNative }, { toolFetches: [], toolCalls: orderedText }).toolCalls.length, 2, 'array order must distinguish args');
assert.equal(nativeResponse([calls[1], { ...calls[1], id: 'read-another' }], { toolFetches: [], toolCalls: [action] }).toolCalls.length, 2, 'distinct native calls keep both IDs even when arguments match');
const textRepeated = await run(round => round === 0 ? { ...done, toolCalls: [action, action] } : done);
assert.equal(textRepeated.executed.length, 2, 'text-only sequences are not cross-protocol echoes');
console.log('PASS cross-protocol deduplication: execute once, nested object key order, distinct arguments, array order, native IDs and text-only sequences.');

for (const success of [false, true]) {
  const exhausted = await run(() => ({ ...done, toolCalls: [action] }), { success });
  assert.equal(exhausted.rounds, 8);
  assert.equal(exhausted.executed.length, 8);
  assert.match(exhausted.messages.at(-1).text, /8 轮处理上限.*尚未完成/);
  assert.match(exhausted.notices[0], /处理上限/);
  assert.ok(exhausted.notices.every(text => !text.includes('已完成')));
}
const openPanel = await run(() => ({ ...done, toolCalls: [action] }), { panelOpen: true });
assert.deepEqual(openPanel.notices, []);
assert.match(openPanel.messages.at(-1).text, /处理上限/);
const failureThenReply = await run(round => round === 0 ? { ...done, toolCalls: [action] } : done, { success: false });
assert.deepEqual(failureThenReply.notices, ['AI助手已回复，请查看结果']);
assert.ok(!failureThenReply.messages.some(m => m.text.includes('处理上限')));
const stopped = await run(() => ({ ...done, toolCalls: [action] }), { stopAfterTool: true });
assert.equal(stopped.rounds, 1);
assert.deepEqual(stopped.notices, ['操作已中止']);
assert.ok(!stopped.messages.some(m => m.text.includes('处理上限')));
const batch = [calls[1], calls[3], { ...calls[1], id: 'read-last' }];
const stoppedBatch = await run(() => nativeResponse(batch), { stopAfterTool: true });
assert.equal(stoppedBatch.executed.length, 1, 'stop must cancel later actions in the same response');
for (let i = 0; i < batch.length; i++) {
  const results = stoppedBatch.messages.filter(m => m.toolCallId === batch[i].id);
  assert.equal(results.length, 1, 'cancelled calls still need exactly one replay result');
  assert.equal(results[0].toolSuccess, i === 0);
  if (i > 0) assert.match(results[0].text, /未执行/);
}
for (const options of [{ stopOnPaint: true }, { stopBeforeResponse: true }]) {
  const cancelled = await run(() => nativeResponse(calls), options);
  assert.equal(cancelled.executed.length, 0, 'stop before execution must prevent every action');
  assert.deepEqual(cancelled.notices, ['操作已中止']);
  for (const call of calls) assert.equal(cancelled.messages.filter(m => m.toolCallId === call.id).length, 1);
}
const requestCancelled = await run(() => done, { abortDuringRequest: true });
assert.equal(requestCancelled.executed.length, 0);
assert.match(requestCancelled.messages.at(-1).text, /用户中止/);
assert.deepEqual(requestCancelled.notices, ['操作已中止']);
console.log('PASS cancellation: stop within a batch, before response, during paint and during model request; completed results retained, cancelled native IDs paired.');
const errored = await run(() => { throw Error('模拟网络失败'); });
assert.match(errored.messages.at(-1).text, /模拟网络失败/);
assert.deepEqual(errored.notices, ['AI助手生成失败了...']);
console.log('PASS completion states: failed/successful round exhaustion, panel open, failure followed by reply, interruption and exception.');
