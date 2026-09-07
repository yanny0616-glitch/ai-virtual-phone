import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const js = source => stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const context = vm.createContext({ console,
  resolvePromptTimeAware: value => value,
  buildCharacterTimeContext: () => ({}), buildGroupTimeContext: () => ({}),
  getPromptTimestampOptionsForTimeContext: () => ({}),
  stripStateAndInnerForPrompt: value => value,
  matchesActiveTags: (tags, active) => !tags?.length || tags.every(tag => active.includes(tag)),
});
vm.runInContext(js(read('lib/llm-prompt-assembler.ts')) + '\nglobalThis.api={assemblePromptPayload,assembleGroupPromptPayload,applyInputRegex,applyAllOutputRegex};', context);
const { assemblePromptPayload, assembleGroupPromptPayload, applyInputRegex, applyAllOutputRegex } = context.api;
const rule = { id: 'r', scriptName: '删除用户历史', findRegex: '/[\\s\\S]+/g', replaceString: '', placement: [1], historyOnly: true, promptOnly: true, historyRole: 'user', tags: ['offline'], minDepth: 2 };
const groups = r => [{ id: 'g', rules: [r] }];
const history = [
  ['user', '<content>USER_OLD</content><summary>用户也能有标签</summary>'],
  ['assistant', 'ASSISTANT_PLAIN'], ['user', 'USER_SECOND'],
  ['assistant', '<content>ASSISTANT_TAGGED</content><summary>摘要</summary>'],
  ['user', 'USER_CURRENT'],
].map(([role, content], i) => ({ id: String(i), sessionId: 's', role, content, createdAt: i + 1, status: 'sent' }));
const historyBefore = plain(history);
const input = { character: { id: 'c', name: '角色' }, members: [], groupName: '群', memberNames: [], history, preset: null, worldBooks: [], regexes: groups(rule), timeAware: false, appTags: ['chat', 'offline'] };
const assembled = [];
for (const assemble of [assemblePromptPayload, assembleGroupPromptPayload]) {
  for (const chronological of [false, true]) {
    const result = assemble({ ...input, ...(chronological ? { unifiedRecentItems: history.map((_, historyIndex) => ({ kind: 'history', historyIndex })) } : {}) });
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /USER_OLD|USER_SECOND/);
    assert.match(output, /USER_CURRENT/);
    assert.match(output, /ASSISTANT_PLAIN/);
    assert.match(output, /ASSISTANT_TAGGED/);
    assembled.push(result);
  }
}
assert.deepEqual(history, historyBefore);
for (const ctx of [{}, { history: false, historyRole: 'user' }, { history: true, historyRole: 'assistant' }, { history: true, historyRole: 'user', depth: 1 }]) {
  assert.equal(applyInputRegex('keep', groups(rule), { activeTags: ['offline'], depth: 3, ...ctx }), 'keep');
}
assert.equal(applyInputRegex('delete', groups(rule), { history: true, historyRole: 'user', depth: 3, activeTags: ['offline'] }), '');
assert.equal(applyInputRegex('keep', groups(rule), { history: true, historyRole: 'user', depth: 3, activeTags: ['chat'] }), 'keep');
assert.equal(applyInputRegex('old behavior', groups({ ...rule, historyRole: undefined }), { history: true, historyRole: 'assistant', depth: 3, activeTags: ['offline'] }), '');
assert.equal(applyAllOutputRegex('visible reply', groups({ ...rule, placement: [2], promptOnly: false }), { activeTags: ['offline'] }), 'visible reply');
console.log('PASS actual direct/group chronological/regular assemblers; sender, depth, scope and compatibility');

const provider = vm.createContext({ console,
  determineBaseUrl: config => config.baseUrl, buildChatCompletionsUrl: url => url + '/chat/completions',
  buildRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  isNativeAnthropicApi: config => config.provider === 'Anthropic',
  isNativeGoogleApi: config => config.provider === 'Gemini',
  shouldOmitDeprecatedSamplingParameters: () => false, stripHallucinatedTimestamps: text => text,
  resolveEnabledGenerationParameters: () => new Set(),
});
vm.runInContext(js(read('lib/llm-provider-adapter.ts')) + '\nglobalThis.api={buildProviderRequest,toLlmRequestMessages,debugMessagesFromRequest};', provider);
const { buildProviderRequest, toLlmRequestMessages, debugMessagesFromRequest } = provider.api;
for (const name of ['OpenAI', 'Anthropic', 'Gemini']) for (const stream of [false, true]) {
  const config = { provider: name, baseUrl: 'https://model.test', apiKey: 'test', defaultModel: 'test', enableImageRecognition: true, enableNativeTools: true };
  for (const payload of assembled) {
    const request = buildProviderRequest(config, null, toLlmRequestMessages(payload), { stream });
    const output = JSON.stringify(request.body);
    assert.doesNotMatch(output, /USER_OLD|USER_SECOND/);
    assert.match(output, /USER_CURRENT/);
    assert.match(output, /ASSISTANT_PLAIN/);
    for (const row of debugMessagesFromRequest(request)) assert.ok(row.content.trim(), `${name} has empty debug row`);
    for (const row of request.messagesForLog) assert.ok(typeof row.content !== 'string' || row.content.trim(), `${name} has empty log row`);
  }
  const messages = [
    { role: 'system', content: 'system' },
    ...['', ' \n ', [], [{ type: 'text', text: ' ' }]].map(content => ({ role: 'user', content, marker: 'DELETED' })),
    { role: 'assistant', content: ' \t ', marker: 'DELETED' },
    { role: 'user', content: [{ type: 'text', text: '' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    { role: 'user', content: 'current' },
    { role: 'assistant', content: ' ', toolCalls: [{ id: 'call1', name: 'lookup', args: { key: 'value' }, thoughtSignature: 'test-signature' }] },
    { role: 'tool', content: '', name: 'lookup', toolCallId: 'call1' },
    { role: 'user', content: 'continue' },
  ];
  const before = plain(messages);
  const request = buildProviderRequest(config, null, messages, { stream, tools: [{ name: 'lookup', description: 'test', parameters: { type: 'object', properties: {} } }] });
  assert.deepEqual(messages, before);
  assert.doesNotMatch(JSON.stringify(request), /DELETED/);
  assert.match(JSON.stringify(request.body), /AA==/);
  assert.match(JSON.stringify(request.body), /lookup/);
  if (name === 'OpenAI') {
    assert.ok(request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call1'));
    assert.ok(request.body.messages.some(message => message.tool_calls?.[0]?.id === 'call1'));
    assert.ok(!request.body.messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? !message.content.trim() : !message.content.length)));
  } else if (name === 'Anthropic') {
    assert.match(JSON.stringify(request.body), /tool_use_id/);
    assert.match(JSON.stringify(request.body), /call1/);
  } else {
    assert.match(JSON.stringify(request.body), /functionResponse/);
    assert.match(JSON.stringify(request.body), /test-signature/);
  }
}
console.log('PASS all three provider request/log/debug paths, streaming and nonstreaming; images and empty native tool results preserved');

const storage = read('lib/settings-storage.ts');
const parse = storage.slice(storage.indexOf('export function parseRegexFromJson('), storage.indexOf('// --- API Configs'));
const imports = vm.createContext({ createRegexGroup: name => ({ name, rules: [] }), generateId: () => 'generated', normalizeRegexRuleTags: tags => tags, UNSUPPORTED_IMPORT_FORMAT: 'unsupported' });
vm.runInContext(js(parse) + '\nglobalThis.parse=parseRegexFromJson;', imports);
const imported = imports.parse(JSON.stringify({ name: 'roundtrip', rules: [rule, { ...rule, historyRole: 'invalid' }] }));
assert.equal(imported.rules[0].historyRole, 'user');
assert.equal(imported.rules[0].historyOnly, true);
assert.equal(imported.rules[0].minDepth, 2);
assert.equal(imported.rules[1].historyRole, undefined);
console.log('PASS group import keeps sender and history restrictions');
