#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { test } from 'node:test';

const root = new URL('../custom-apps/xiao-ju-chang/src/', import.meta.url);
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const nodes = new Map(), listeners = [], calls = [], notices = [];
  function node() {
    return {
      children: [], style: {}, hidden: true, isConnected: true, contentWindow: {},
      classList: { add() {}, remove() {}, toggle() {} },
      set innerHTML(value) { this.children.forEach(n => { n.isConnected = false; }); this.children = []; },
      get innerHTML() { return ''; },
      appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
      setAttribute() {}, remove() { this.isConnected = false; }, querySelector() { return null; }, querySelectorAll() { return []; },
    };
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const state = {
    settings: { lengthLimit: true, defaultLength: 'short' }, characters: [{ id: 'A', name: 'Alice' }, { id: 'B', name: 'Bob' }],
    character: { id: 'A', name: 'Alice' }, userName: 'User', view: 'stage', busy: false,
    combos: [], prompts: [{ id: 'p', title: 'Format', tags: ['形式'], content: 'ORIGINAL_PROMPT {{char}} {{随机词:word}}' }],
    preambles: [{ id: 'pre', name: 'Original preamble', content: 'ORIGINAL_PREAMBLE' }],
    randoms: [{ id: 'r', title: 'Random', content: 'ORIGINAL_RANDOM' }],
    macros: [{ id: 'm', kind: 'words', name: 'word', values: ['ORIGINAL_MACRO'] }], recents: [], favorites: [],
  };
  const tables = { recents: [], favorites: [], combos: state.combos };
  let serial = 0;
  const api = {
    ai: {
      generate: async payload => { calls.push({ kind: 'generate', ...payload }); return { text: '标题：Story\nStory body', model: 'mock' }; },
      chat: async payload => { calls.push({ kind: 'chat', ...payload }); return { text: '标题：Raw\nRaw body' }; },
    },
    user: { getProfile: async () => ({ name: "User" }), getPersona: async () => ({ text: "USER_PERSONA" }) },
    characters: { get: async id => state.characters.find(c => c.id === id) },
    chat: { readHistory: async payload => { calls.push({ kind: 'history', ...payload }); return { messages: [{ role: 'user', content: 'chat' }] }; } },
    memory: { readCore: async () => ({ text: "CORE" }), readLongTerm: async () => ({ text: "LONG" }), readShortTerm: async () => ({ text: "SHORT" }), add: async payload => { calls.push({ kind: 'memory', ...payload }); } },
    db: {
      list: async (name, query = {}) => clone((tables[name] || []).slice(query.offset || 0, (query.offset || 0) + (query.limit || 100))),
      create: async (name, data) => { const row = { ...clone(data), id: `row-${++serial}` }; (tables[name] ||= []).push(row); return clone(row); },
      update: async (name, id, data) => { const row = tables[name].find(r => r.id === id); assert.ok(row, 'must not resurrect a deleted combo'); Object.assign(row, clone(data)); return clone(row); },
      delete: async (name, id) => { tables[name] = tables[name].filter(r => r.id !== id); },
    },
  };
  const context = createContext({ console, state, api, $, clone, el: node, notices,
    window: { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } },
    document: { createElement: node, querySelector: node, createTextNode: node },
    getComputedStyle: () => ({ getPropertyValue: () => '', fontFamily: 'sans-serif' }),
    byId: (list, id) => list.find(r => r.id === id) || null,
    charName: c => c?.name || '', esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), toast: s => notices.push(s), fail: e => { throw e; },
    viewHooks: {}, fmtTime: () => '', fmtFull: () => '',
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Date,
    throttle: fn => { const run = v => fn(v); run.cancel = () => {}; return run; },
    switchView: view => { state.view = view; },
  });
  for (const file of ['core/macros.js', 'data/defaults.js', 'data/validation.js', 'data/scan.js', 'data/storage.js', 'gen/assemble.js', 'ui/theme.js', 'ui/render.js', 'ui/stage.js', 'ui/favorites.js']) {
    new Script(readFileSync(new URL(file, root), 'utf8'), { filename: file }).runInContext(context);
  }
  const app = new Script('({stage, favorites, captureCombo, generateTheater, buildTasks, aiPickCombo, writeBackMemory, mountFrame, openFullscreen, frames, importBundle, exportBundle, validateBundle, upsert, remove, clearCollection, loadCollection, recentHistory, scanLooseJson})').runInContext(context);
  // Skip unrelated layout; keep actual generation, persistence, handlers and frame routing.
  app.stage.showResult = result => { state.result = result; };
  app.stage.renderLead = () => {}; app.stage.renderRecent = () => {}; app.favorites.render = () => {};
  const combo = { id: 'C', name: 'Original combo', preambleId: 'pre', promptIds: ['p'], random: { count: 1 }, output: { mode: 'text', length: 'default' }, memory: { mode: 'recent', rounds: 2 }, writeBack: true, useCount: 0 };
  state.combos.push(combo);
  for (const name of ["combos", "preambles", "prompts", "randoms", "macros"]) tables[name] = clone(state[name]);
  return { ...app, state, api, calls, notices, combo, $, tables, node, emit: e => listeners.forEach(fn => fn(e)) };
}

test('generation keeps original character and dependencies across async work', async () => {
  const h = harness(), pending = deferred(), entered = deferred();
  h.api.chat.readHistory = async payload => { h.calls.push({ kind: 'history', ...payload }); entered.resolve(); return pending.promise; };
  const run = h.stage.run(h.combo);
  await entered.promise;
  h.state.character = h.state.characters[1];
  h.combo.name = 'Edited while waiting'; h.state.prompts[0].content = 'EDITED_PROMPT';
  pending.resolve({ messages: [{ role: 'user', content: 'original chat' }] });
  await run;
  const call = h.calls.find(c => c.kind === 'generate');
  assert.equal(call.characterId, 'A');
  assert.match(call.instruction, /ORIGINAL_PROMPT Alice ORIGINAL_MACRO/);
  assert.equal(h.state.result.characterId, 'A');
  assert.equal(h.state.result.comboCopy.name, 'Original combo');
  assert.equal(h.calls.find(c => c.kind === 'memory').characterId, 'A');
  assert.equal(h.state.combos[0].plays.A, 1);
  assert.equal(h.state.combos[0].plays.B, undefined);
  assert.equal(h.state.combos[0].name, 'Edited while waiting');
});

test('saved AI-pick tasks survive a second generation', async () => {
  const h = harness();
  await h.stage.run(h.aiPickCombo());
  const result = clone(h.state.result);
  h.state.prompts = []; h.state.preambles = []; h.state.randoms = []; h.state.macros = [];
  await h.stage.run(h.stage.comboOf(result));
  const calls = h.calls.filter(c => c.kind === 'generate');
  assert.match(calls[1].instruction, /任务 1 · AI 自选/);
  assert.match(calls[1].instruction, /ORIGINAL_PROMPT/);
  assert.match(calls[1].instruction, /ORIGINAL_PREAMBLE/);
});

test('favorites replay complete dependencies after edits, export/import and deletion', async () => {
  const h = harness();
  await h.stage.run(h.combo);
  await h.stage.handlers().fav(h.state.result);
  const favorite = clone(h.state.favorites[0]);
  const bundle = clone(h.exportBundle());
  h.combo.name = 'Changed'; h.state.prompts[0].content = 'CHANGED';
  assert.equal(h.stage.comboOf(favorite).name, 'Original combo');
  h.state.combos.length = 0; h.state.prompts = []; h.state.preambles = []; h.state.randoms = []; h.state.macros = [];
  h.state.settings.defaultLength = 'long';
  await h.stage.run(h.stage.comboOf(favorite));
  const call = h.calls.filter(c => c.kind === 'generate').at(-1);
  for (const text of ['ORIGINAL_PREAMBLE', 'ORIGINAL_PROMPT', 'ORIGINAL_MACRO', 'ORIGINAL_RANDOM', '约 400 字']) assert.ok(call.instruction.includes(text), text);
  assert.equal(h.state.combos.length, 0, 'replay must not recreate deleted source combo');
  const target = harness();
  await target.importBundle(bundle);
  target.state.prompts = []; target.state.preambles = []; target.state.randoms = []; target.state.macros = [];
  await target.stage.run(target.stage.comboOf(target.state.favorites[0]));
  assert.match(target.calls.find(c => c.kind === 'generate').instruction, /ORIGINAL_PROMPT Alice ORIGINAL_MACRO/);
});

test('frame actions use their own favorite and reject forged, stale and hidden sources', async () => {
  const h = harness();
  const result = { characterId: 'A', title: 'Favorite', raw: 'FAVORITE_BODY', comboCopy: h.captureCombo(h.combo) };
  h.state.character = h.state.characters[1];
  h.state.result = { comboId: 'unrelated' };
  h.state.view = 'fav';
  h.openFullscreen(result, h.stage.handlers());
  const [id, entry] = [...h.frames].at(-1);
  let invoked;
  h.stage.run = (...args) => { invoked = args; };
  const message = { source: entry.iframe.contentWindow, data: { source: 'xjc-frame', type: 'action', id, text: 'choice' } };
  h.emit({ ...message, source: {} }); assert.equal(invoked, undefined);
  h.emit({ ...message, data: { ...message.data, id: 'unknown' } }); assert.equal(invoked, undefined);
  h.$('fullscreen').hidden = true; h.emit(message); assert.equal(invoked, undefined);
  h.$('fullscreen').hidden = false; entry.iframe.isConnected = false; h.emit(message); assert.equal(invoked, undefined);
  entry.iframe.isConnected = true;
  h.state.result = null; // Fullscreen favorites must work even with no stage result.
  h.emit(message);
  assert.equal(invoked[0].name, 'Original combo');
  assert.match(invoked[1], /FAVORITE_BODY/); assert.match(invoked[1], /choice/);
  assert.equal(invoked[2].id, 'A'); assert.equal(h.state.view, 'stage');
  invoked = undefined; h.emit(message); assert.equal(invoked, undefined, 'closed frame must stop dispatching');
});

test('legacy results retain fallback without overriding an available combo copy', () => {
  const h = harness();
  assert.equal(h.stage.comboOf({ comboId: 'C' }).name, 'Original combo');
  assert.equal(h.stage.comboOf({ comboId: 'C', comboCopy: { name: 'Legacy snapshot' } }).name, 'Legacy snapshot');
  assert.equal(h.stage.comboOf({ comboId: 'missing' }), null);
});

test('queued patches merge against latest row and duplicate draft saves are coalesced', async () => {
  const h = harness();
  await Promise.all([h.upsert('combos', { id: 'C', name: 'Edited' }), h.upsert('combos', { id: 'C', useCount: 7 })]);
  assert.equal(h.state.combos[0].name, 'Edited'); assert.equal(h.state.combos[0].useCount, 7);
  const draft = { ...clone(h.combo), id: undefined, name: 'New draft' };
  const [a, b] = await Promise.all([h.upsert('combos', draft), h.upsert('combos', draft)]);
  assert.equal(a.id, b.id); assert.equal(draft.id, a.id);
  assert.equal(h.state.combos.filter(c => c.name === 'New draft').length, 1);
});

test('favorite removal/clear can be reversed by re-favoriting and clicks are coalesced', async () => {
  const h = harness(); await h.stage.run(h.combo);
  const r = h.state.result;
  const [a, b] = await Promise.all([h.stage.handlers().fav(r), h.stage.handlers().fav(r)]);
  assert.equal(a, b); assert.equal(h.state.favorites.length, 1);
  await h.remove('favorites', a);
  assert.equal(r.favoriteId, '');
  await h.stage.handlers().fav(r); assert.equal(h.state.favorites.length, 1);
  const favorite = h.state.favorites[0];
  await h.stage.handlers().fav(favorite); assert.equal(h.state.favorites.length, 1, 'viewing a favorite on stage must not duplicate it');
  await h.clearCollection('favorites');
  await h.stage.handlers().fav(r); assert.equal(h.state.favorites.length, 1);
});

test('load/export/clear cover multiple SDK pages and quarantine invalid legacy rows', async () => {
  const h = harness();
  h.tables.favorites = Array.from({ length: 1201 }, (_, i) => ({ id: `f${i}`, title: `Story ${i}`, raw: 'body' }));
  h.tables.favorites.push({ id: 'invalid', raw: 'body', segments: 'wrong' });
  await h.loadCollection('favorites');
  assert.equal(h.state.favorites.length, 1201);
  const bundle = h.exportBundle();
  assert.equal(bundle.favorites.length, 1201); assert.equal(bundle.invalidRecords.favorites.length, 1);
  await h.clearCollection('favorites'); assert.equal(h.tables.favorites.length, 0);
});

test('legacy SDK without offset support fails explicitly instead of truncating backup', async () => {
  const h = harness();
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, raw: 'body' }));
  h.api.db.list = async () => rows;
  await assert.rejects(h.loadCollection('favorites'), /新版宿主/);
});

test('invalid bundle is rejected before writing any earlier valid rows', async () => {
  const h = harness(), before = JSON.stringify(h.tables);
  await assert.rejects(h.importBundle({ app: 'float.xiaojuchang', prompts: [{ title: 'Valid', content: 'valid' }], randoms: [{ title: 'Bad', content: 'bad', tags: 'wrong' }] }), /文本数组/);
  assert.equal(JSON.stringify(h.tables), before);
  await assert.rejects(h.importBundle({ app: 'float.xiaojuchang', combos: [{ name: 'Missing', promptIds: ['missing'] }] }), /不存在的提示词/);
  assert.equal(JSON.stringify(h.tables), before);
  await assert.rejects(h.importBundle({ app: 'float.xiaojuchang', combos: [{ name: 'Regex', output: { wrapTag: '(a+)+' } }] }), /标签名称/);
});

test('recent history clears launch session, fills filtered pages and supplies all 50 pairs in task', async () => {
  const h = harness();
  const source = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `HISTORY_${i}_END`, mediaType: i >= 100 ? 'app_card' : '' }));
  const queries = [];
  h.api.chat.readHistory = async q => {
    queries.push(q); const end = q.before ? source.findIndex(m => m.id === q.before) : source.length;
    return { characterId: q.characterId, messages: source.slice(Math.max(0, end - q.limit), end) };
  };
  await h.generateTheater({ ...h.combo, memory: { mode: 'recent', rounds: 50 } });
  assert.equal(queries.length, 2); assert.ok(queries.every(q => q.sessionId === '' && q.characterId === 'A'));
  const c = h.calls.find(c => c.kind === 'generate');
  assert.equal((c.instruction.match(/HISTORY_\d+_END/g) || []).length, 100);
  assert.equal(c.messages.length, 0); assert.equal(c.promptProfile.history, 'none');
  assert.ok(!c.promptProfile.include.includes('shortTermMemory'));
  h.api.chat.readHistory = async () => ({ characterId: 'B', messages: [] });
  await assert.rejects(h.recentHistory('A', 5), /不一致/);
  h.api.chat.readHistory = async () => { throw new Error('chat.readHistory 找不到会话。'); };
  assert.equal((await h.recentHistory('A', 5)).length, 0);
});

test('raw mode supplies explicit API owner, bound user persona and host memories', async () => {
  const h = harness(), reads = [];
  h.api.user.getProfile = async q => { reads.push(q); return { name: `${q.characterId}-User` }; };
  h.api.user.getPersona = async q => { reads.push(q); return { text: 'BOUND_PERSONA' }; };
  for (const method of ['readCore', 'readLongTerm', 'readShortTerm']) h.api.memory[method] = async q => { reads.push(q); return { text: method }; };
  await h.generateTheater({ ...h.combo, rawChannel: true, memory: { mode: 'host' } });
  const c = h.calls.find(c => c.kind === 'chat'), text = c.messages.map(m => m.content).join('\n');
  assert.equal(c.characterId, 'A'); assert.ok(reads.every(q => q.characterId === 'A'));
  for (const part of ['A-User', 'BOUND_PERSONA', 'readCore', 'readLongTerm', 'readShortTerm']) assert.ok(text.includes(part), part);
  reads.length = 0; h.calls.length = 0;
  await h.generateTheater({ ...h.combo, rawChannel: true, who: 'observer', memory: { mode: 'none' } });
  assert.equal(reads.length, 1, 'only profile lookup; no persona or memory reads');
  const bare = h.calls.find(c => c.kind === 'chat').messages.map(m => m.content).join('\n');
  assert.ok(!bare.includes('BOUND_PERSONA')); assert.ok(!bare.includes('readCore'));
});

test('loose JSON scan lists prompt-like passages from tavern presets and cards without duplicates or junk', () => {
  const h = harness();
  const long = '这一段是一条完整的系统提示词，足够长，里面还有空格 和标点。';
  const preset = {
    prompts: [
      { identifier: 'main', name: '主提示', system_prompt: true, content: long },
      { identifier: 'chatHistory', name: '聊天记录', marker: true },
      { identifier: 'nsfw', name: '', content: long + ' 第二条' },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    impersonation_prompt: '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline.]',
    avatar: 'data:image/png;base64,' + 'A'.repeat(200), homepage: 'https://example.com/a/very/long/url/that/is/not/prose',
    temperature: 0.9,
  };
  const found = h.scanLooseJson(preset);
  assert.deepEqual(Array.from(found, f => f.name), ['主提示', 'nsfw', 'impersonation_prompt'], 'document order; empty name falls back to identifier');
  assert.equal(found[0].path, '$.prompts[0].content');
  const card = { name: 'Alice', description: long, personality: long + ' 性格', data: { name: 'Alice', description: long, character_book: { entries: [{ comment: '城市', content: long + ' 世界书' }] } } };
  const names = Array.from(h.scanLooseJson(card), f => f.name);
  assert.deepEqual(names, ['Alice · description', 'Alice · personality', '城市']);
  assert.equal(h.scanLooseJson({ a: 1, b: 'short' }).length, 0);
});

test('staged HTML runs shell then fill with the same randoms, shows the shell early, and honours cancel', async () => {
  const h = harness();
  h.api.ai.generate = async payload => {
    h.calls.push({ kind: 'generate', ...payload });
    if (/data-slot/.test(payload.instruction)) return { text: '标题：Shell\n<div><h3>Forum</h3><span data-slot="1" data-hint="楼主"></span><p data-slot="2" data-hint="回复"></p></div>', model: 'mock' };
    if (/\[\[编号\]\]/.test(payload.instruction)) return { text: '[[1]]\nFIRST<br>LINE\n[[2]]\nSECOND & more\n<b>x</b>', model: 'mock' };
    return { text: '标题：Plain\n<div>plain</div>', model: 'mock' };
  };
  const staged = { ...h.combo, output: { mode: 'html', staged: true, length: 'default' } };
  let shell = null;
  const gen = await h.generateTheater(staged, { onShell: s => { shell = s; } });
  assert.equal(shell.slots.length, 2); assert.equal(shell.title, 'Shell');
  assert.ok(shell.segments[0].content.includes('data-slot="1"'), 'shell keeps placeholders for the early render');
  const [first, second] = h.calls.filter(c => c.kind === 'generate');
  assert.ok(first.instruction.includes('ORIGINAL_RANDOM') && second.instruction.includes('ORIGINAL_RANDOM'), 'fill reuses the drawn randoms');
  assert.ok(second.instruction.includes('[[1]] 楼主') && second.instruction.includes('[[2]] 回复'));
  assert.match(second.instruction, /Forum\s+\[\[1\]\]\s+\[\[2\]\]/, 'outline carries the shell text around each slot');
  const html = gen.segments[0].content;
  assert.ok(html.includes('<span data-slot="1" data-hint="楼主">FIRST<br>LINE</span>'), html);
  assert.ok(html.includes('SECOND &amp; more<br>&lt;b&gt;x&lt;/b&gt;'), 'fill text is escaped except <br>');
  assert.deepEqual(Object.keys(gen.fill).sort(), ['1', '2']);
  assert.equal(gen.snapshot.staged, true);
  h.calls.length = 0; let cancelled = false;
  const none = await h.generateTheater(staged, { onShell: () => { cancelled = true; }, isCancelled: () => cancelled });
  assert.equal(none, null); assert.equal(h.calls.filter(c => c.kind === 'generate').length, 1, 'no fill call after cancel');
  h.api.ai.generate = async () => ({ text: '标题：NoSlots\n<div>done</div>', model: 'mock' });
  const plain = await h.generateTheater(staged, { onShell: () => assert.fail('no shell callback when the model ignores placeholders') });
  assert.equal(plain.snapshot.staged, false); assert.equal(plain.segments[0].content, '<div>done</div>');
});

test('streaming: onStream gets think-stripped preview text, staged fill previews partial slot maps, and no handlers are sent when off', async () => {
  const h = harness();
  const feed = async (handlers, parts) => { let acc = ''; for (const part of parts) { acc += part; if (handlers && handlers.onChunk) handlers.onChunk({ delta: part, text: acc }); } return acc; };
  let seen = [];
  h.api.ai.generate = async (payload, handlers) => {
    h.calls.push({ kind: 'generate', handlers: !!handlers, ...payload });
    if (/data-slot/.test(payload.instruction)) return { text: await feed(handlers, ['标题：Shell\n<div><span data-slot="1" data-hint="a"></span>', '<p data-slot="2" data-hint="b"></p></div>']), model: 'mock' };
    if (/\[\[编号\]\]/.test(payload.instruction)) return { text: await feed(handlers, ['[[1]]\nfirst ha', 'lf\n[[2]]\nsec', 'ond']), model: 'mock' };
    return { text: await feed(handlers, ['<think>secret', ' plan</think>标题：Live\n第一', '段\n\n第二段']), model: 'mock' };
  };
  const events = [];
  const gen = await h.generateTheater(h.combo, { onStream: ev => events.push(ev) });
  assert.equal(gen.title, 'Live');
  assert.deepEqual(events.map(e => e.kind), ['text', 'text', 'text']);
  assert.ok(events.every(e => !e.text.includes('secret')), 'unclosed and closed think tags are stripped from previews');
  assert.equal(events[0].text, ''); assert.equal(events[1].text, '标题：Live\n第一'); assert.equal(events.at(-1).text, gen.raw.replace(/<think>[\s\S]*?<\/think>/, ''));
  assert.ok(events.every(e => e.snapshot && e.snapshot.comboName), 'preview events carry the task snapshot');
  events.length = 0;
  const staged = { ...h.combo, output: { mode: 'html', staged: true, length: 'default' } };
  await h.generateTheater(staged, { onStream: ev => events.push(ev), onShell: () => {} });
  assert.deepEqual(events.map(e => e.kind), ['shell', 'shell', 'fill', 'fill', 'fill']);
  assert.deepEqual(events.slice(2).map(e => Array.from(Object.keys(e.fill))), [['1'], ['1', '2'], ['1', '2']]);
  assert.equal(events[2].fill['1'], 'first ha'); assert.equal(events.at(-1).fill['2'], 'second');
  seen = []; h.calls.length = 0;
  await h.generateTheater(h.combo, {});
  assert.equal(h.calls.at(-1).handlers, false, 'no onStream → no second argument, old hosts see the plain call');
  let cancelled = false; events.length = 0;
  h.api.ai.generate = async (payload, handlers) => { handlers.onChunk({ delta: 'a', text: 'a' }); cancelled = true; handlers.onChunk({ delta: 'b', text: 'ab' }); return { text: 'ab' }; };
  assert.equal(await h.generateTheater(h.combo, { onStream: ev => events.push(ev), isCancelled: () => cancelled }), null);
  assert.equal(events.length, 1, 'chunks after cancel are dropped');
});
