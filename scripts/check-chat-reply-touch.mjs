// 聊天手感：格式自愈、撤回 / 表情回应 / 引用对准、打字节奏三档。纯函数层面的回归检查。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const js = s => stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const load = (file, names) => {
  const c = vm.createContext({});
  vm.runInContext(js(read(file)) + `\nglobalThis.api={${names.join(',')}};`, c);
  return c.api;
};

// ── 格式自愈 ──
const repair = load('lib/reply-format-repair.ts', ['stripFormatMetaTalk', 'rejoinBrokenLines']);
assert.equal(repair.stripFormatMetaTalk('Writing the JSON lines:\n今天好累\n\n想你了'), '今天好累\n\n想你了');
assert.equal(repair.stripFormatMetaTalk('1. 按格式输出聊天消息\n嗯嗯\n\n吃了吗'), '嗯嗯\n\n吃了吗');
assert.equal(repair.stripFormatMetaTalk('我跟你说：\n明天见'), '我跟你说：\n明天见', '普通冒号句保留');
assert.equal(repair.stripFormatMetaTalk('Let me write:\nHere is the output:'), 'Let me write:\nHere is the output:', '删一半以上视为误判');
assert.equal(repair.stripFormatMetaTalk('[表情包:开心]\n好'), '[表情包:开心]\n好');
console.log('PASS 格式说明行被剥掉，普通台词和指令行保留');

assert.equal(repair.rejoinBrokenLines('再\n把咱们赏月的心情\n给搅了'), '再把咱们赏月的心情给搅了');
assert.equal(repair.rejoinBrokenLines('你是不是\n不想理我了\n吗'), '你是不是\n不想理我了吗');
assert.equal(repair.rejoinBrokenLines('床前明月光\n疑是地上霜'), '床前明月光\n疑是地上霜', '诗句分行保留');
assert.equal(repair.rejoinBrokenLines('哈哈哈\n笑死'), '哈哈哈\n笑死');
assert.equal(repair.rejoinBrokenLines('我回来了\n给你带了奶茶'), '我回来了\n给你带了奶茶', '上一句已收尾不接');
assert.equal(repair.rejoinBrokenLines('好啊。\n的确'), '好啊。\n的确', '标点结尾不接');
assert.equal(repair.rejoinBrokenLines('see you\ntomorrow'), 'see you tomorrow');
assert.equal(repair.rejoinBrokenLines('OK\nSee you'), 'OK\nSee you');
console.log('PASS 断开的半句接回，诗、刻意分行、收尾句保留');

// ── 撤回 / 表情回应 / 引用 ──
const actions = load('lib/chat-reply-actions.ts', ['extractReplyRoundActions', 'findRecallTarget', 'findReactionTarget', 'findQuoteTarget', 'addReaction']);
{
  const r = actions.extractReplyRoundActions('我想你了\n\n[撤回:我想你了]\n\n没什么\n\n[回应:😂|你个笨蛋]\n\n[回应:好的]\n\n[撤回:没什么]');
  assert.deepEqual(JSON.parse(JSON.stringify(r.actions)), [
    { kind: 'recall', text: '我想你了' },
    { kind: 'react', emoji: '😂', target: '你个笨蛋' },
  ], '一轮一次撤回，非 emoji 回应丢掉');
  assert.equal(r.text.replace(/\n+/g, '|').replace(/^\||\|$/g, ''), '我想你了|没什么');
  assert.deepEqual(JSON.parse(JSON.stringify(actions.extractReplyRoundActions('[回应：👍]').actions)), [{ kind: 'react', emoji: '👍', target: '' }]);
}
{
  const now = Date.parse('2026-11-22T10:00:00Z');
  const at = m => new Date(now - m * 60000).toISOString();
  const msgs = [
    { id: 'a1', role: 'assistant', content: '我想你了', createdAt: at(30) },
    { id: 'u1', role: 'user', content: '你个笨蛋！', createdAt: at(3) },
    { id: 'a2', role: 'assistant', content: '我想你了……', createdAt: at(1) },
    { id: 'u2', role: 'user', content: '在吗', createdAt: at(0.5) },
    { id: 's1', role: 'system', content: '我想你了', createdAt: at(0.2) },
  ];
  assert.equal(actions.findRecallTarget(msgs, '我想你了', now)?.id, 'a2', '撤最新一条，忽略标点');
  assert.equal(actions.findRecallTarget(msgs.slice(0, 2), '我想你了', now), null, '超过 10 分钟不撤');
  assert.equal(actions.findRecallTarget([{ ...msgs[2], isRetracted: true }], '我想你了', now), null);
  assert.equal(actions.findReactionTarget(msgs, '笨蛋')?.id, 'u1');
  assert.equal(actions.findReactionTarget(msgs, '')?.id, 'u2', '没给片段贴最新一条');
  assert.equal(actions.findReactionTarget(msgs, '对不上'), null);
  assert.equal(actions.findQuoteTarget(msgs, '你个笨蛋')?.id, 'u1');
  assert.equal(actions.findQuoteTarget(msgs, '不存在的话'), null);
  assert.equal(actions.addReaction([{ emoji: '😂' }], '😂', 'b'), null, '同一个表情不重复');
  assert.equal(actions.addReaction([{ emoji: '1' }, { emoji: '2' }, { emoji: '3' }], '😂', 'b').length, 3);
}
console.log('PASS 撤回 / 表情回应 / 引用按原话反查目标');

// ── 打字节奏三档 ──
const plugin = (await import('../chat-plugins/typing-rhythm.js')).default;
const setupPlugin = (overrides = {}) => {
  const settings = Object.fromEntries(plugin.manifest.settings.map(s => [s.key, s.default]));
  Object.assign(settings, { jitter: 0, charsPerSec: 5 }, overrides);
  let fn;
  plugin.setup({ system: { settings: { get: k => settings[k] } }, hooks: { transform: (_p, f) => { fn = f; return () => {}; } } });
  return p => fn({ index: 1, total: 3, content: '我今天其实有点不开心', streamed: false, delayMs: 800, cancelled: false, ...p });
};
{
  const realRandom = Math.random;
  Math.random = () => 0.99; // 不触发停顿
  const pace = setupPlugin();
  const normal = pace({});
  const fast = pace({ tempo: 'fast' });
  const slow = pace({ tempo: 'slow' });
  assert.equal(normal.delayMs, 2000, '普通档总时长和 1.x 相同（10 字 ÷ 5 字/秒）');
  assert.equal(normal.pauseMs, 400);
  assert.ok(fast.delayMs < normal.delayMs && slow.delayMs > normal.delayMs, `快 ${fast.delayMs} < 普通 ${normal.delayMs} < 慢 ${slow.delayMs}`);
  assert.ok(slow.pauseMs >= 900, '慢档先沉默一阵');
  assert.equal(slow.stallMs, undefined);
  Math.random = () => 0.01; // 触发停顿
  const stalled = pace({ tempo: 'slow' });
  assert.ok(stalled.stallMs > 0 && stalled.stallAtMs > 0, '慢档会打到一半停下');
  assert.ok(stalled.pauseMs + stalled.stallAtMs + stalled.stallMs <= stalled.delayMs);
  assert.equal(pace({ tempo: 'fast' }).stallMs, undefined, '快档从不停顿');
  const off = setupPlugin({ tempoEnabled: false })({ tempo: 'slow' });
  assert.equal(off.delayMs, 2000, '关掉快慢后按普通算');
  const capped = setupPlugin({ maxDelayMs: 3000 })({ tempo: 'slow', content: '这是一条特别特别长的消息'.repeat(6) });
  assert.ok(capped.delayMs <= 6000, '慢档最多多等 3 秒');
  Math.random = realRandom;
}
console.log('PASS 快 / 普通 / 慢三档时长与停顿');

// ── 宿主按拆分执行：沉默和停顿期间藏起「正在输入」 ──
{
  const src = read('components/chat/chat-room.tsx');
  const start = src.indexOf('    const paceBubbleReveal = '), end = src.indexOf('\n    // Helper:', start);
  assert.ok(start >= 0 && end > start);
  const delays = [], holds = [];
  const c = vm.createContext({
    session: { id: 's', contactId: 'c' },
    getChatPluginRuntime: () => ({ ensureReady: async () => {} }),
    runChatPluginTransform: async (_p, p) => ({ ...p, delayMs: 5000, pauseMs: 1000, stallAtMs: 1500, stallMs: 1000 }),
    abortableDelay: async ms => { delays.push(ms); },
    setTypingHold: v => holds.push(v),
  });
  vm.runInContext(js(src.slice(start, end)) + '\nglobalThis.pace=paceBubbleReveal;', c);
  await c.pace({ content: 'x', index: 1, total: 2, responseBatchId: 'b' }, false);
  assert.deepEqual(delays, [1000, 1500, 1000, 1500]);
  assert.deepEqual(holds, [true, false, true, false, false]);
}
console.log('PASS 宿主按「沉默 → 打字 → 停一下 → 打完」执行');
