import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { checkGuaNianBuild } from './build-gua-nian.mjs';

checkGuaNianBuild();
const html = fs.readFileSync(new URL('../custom-apps/gua-nian/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const h = { items: [], requests: [], writes: [], posts: [], errors: [], response: {} };
const context = vm.createContext({ h, console, Date, Intl, document: {}, AiPhone: {
  calendar: {
    read: async ({ date }) => ({ plan: { items: h.items.map(it => ({ ...it, date })) } }),
    write: async (req) => {
      h.writes.push(req);
      if (req.operation === 'delete') h.items = h.items.filter(it => it.id !== req.itemId);
      else h.items.push({ ...req });
    },
  },
} });
vm.runInContext(script.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
  claimOwner = async () => true;
  owns = () => true;
  render = () => {};
  toast = text => h.errors.push(text);
  log = async () => {};
  recentDaysBrief = async () => ({ lines: [], residue: [] });
  generateJson = async (_cx, req) => { h.requests.push(req); return h.response; };
  upsert = async (_table, _predicate, row) => row;
  orchestrate = async () => {};
  syncChatContext = async () => {};
  cloudGenOn = () => true;
  requireRecheckFeatures = async () => {};
  freezeGenTemplates = async () => ({ daily: 'daily', impulse: 'impulse' });
  cloudContext = () => ({});
  cloudSessionId = async () => 'session';
  cloudFetchBounded = async (_path, req) => {
    if (req.method === 'POST') h.posts.push(JSON.parse(req.body));
    return {};
  };
  globalThis.api = { S, SET_DEF, ctxOf, generateDay, uploadGenKitCloud };
})();`), context);
const a = context.api;
a.S.settings = { ...a.SET_DEF, threadsOn: false, userSleepOn: false };
const cx = a.ctxOf({ id: 'c', name: '角色' });
const manual = { id: 'manual-1', startTime: '10:00', title: '复诊', location: '医院', source: 'manual' };
const external = { id: 'calendar-2', startTime: '12:00', title: '既定午餐', source: 'generated' };
h.items = [manual, external, { id: 'guanian_old', startTime: '18:40', title: '旧晚餐', location: '' }];
for (const [time, title, removedTitle] of [['19:00', '河畔观察候鸟', '旧晚餐'], ['20:00', '整理旧版诗集', '河畔观察候鸟']]) {
  h.response = { schedule: [{ time, title, note: '新的具体细节' }] };
  await a.generateDay(cx);
  assert.deepEqual(h.errors, []);
  const instruction = h.requests.at(-1).instruction;
  assert.ok(!instruction.includes(removedTitle));
  assert.ok(instruction.includes('复诊') && instruction.includes('既定午餐'));
  assert.deepEqual(Array.from(cx.day.schedule, it => it.title), ['复诊', '既定午餐', title]);
  assert.equal(cx.day.schedule.find(it => it.title === title).note, '新的具体细节');
  assert.deepEqual(h.items.filter(it => !it.id.startsWith('guanian_')), [manual, external]);
  assert.deepEqual(h.items.filter(it => it.id.startsWith('guanian_')).map(it => it.title), [title]);
  assert.equal(cx.busy, false);
  assert.equal(cx._planLock, false);
}
assert.ok(h.writes.some(req => req.operation === 'delete' && req.itemId === 'guanian_old'));
// The actual cloud upload path must filter both the prompt and fallback records.
await a.uploadGenKitCloud(cx, true);
assert.equal(h.posts.length, 1);
const kit = h.posts[0].context.genKit;
assert.deepEqual(Array.from(kit.existing, it => it.id), ['manual-1', 'calendar-2']);
assert.ok(!kit.instruction.includes('整理旧版诗集'));
assert.ok(kit.instruction.includes('复诊') && kit.instruction.includes('既定午餐'));
assert.equal(h.items.filter(it => it.id.startsWith('guanian_')).length, 1);
console.log('PASS: repeated regeneration replaces owned calendar entries, preserves other sources, and filters cloud generation inputs.');
