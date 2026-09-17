// 工坊引擎纯函数回归：流式过滤器（隐藏指令/思考块、尾部暂扣、续写标记）、
// 持久化上下文在文本/原生两种协议下的回放、截断与续写判定。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../lib/qa-agent-engine.ts', import.meta.url), 'utf8'))
  .replace(/^import\s[\s\S]*?;\s*$/gm, '')
  .replace(/^export /gm, '');
const ctx = vm.createContext({
  console, Map, Set, JSON, Promise, RegExp, Error, Math, Number, Array, Object, String,
  buildQaNativeNameMap: () => new Map([['read_repo_file', '读取仓库文件']]),
  localStorage: { getItem: () => null },
});
vm.runInContext(`${source};globalThis.__x={createQaStreamFilter,contextToTextMessages,contextToNativeMessages,hasTruncatedDirective,hasContinueMarker,stripThinkBlocks}`, ctx);
const { createQaStreamFilter, contextToTextMessages, contextToNativeMessages, hasTruncatedDirective, hasContinueMarker, stripThinkBlocks } = ctx.__x;

async function runFilter(chunks) {
  let visible = '';
  const holds = [];
  const filter = createQaStreamFilter((t) => { visible += t; }, (h) => { holds.push(h); });
  for (const c of chunks) await filter.push(c);
  await filter.flush();
  return { visible, holds };
}

// 指令整块隐藏，前后正文保留；参数里含 [] 与 ")]" 字符串不会提前截断
{
  const { visible } = await runFilter(['先看看文件。[执行动作:读取仓库文件({"path":"a[0].ts","q":"x)]y"})]', '读完了。']);
  assert.equal(visible, '先看看文件。读完了。');
}
// 指令跨 chunk 到达：中途不泄漏任何指令片段
{
  const { visible } = await runFilter(['好的[执行动作:', '读取仓库文件({"pa', 'th":"lib/a.ts"})]', '完成']);
  assert.equal(visible, '好的完成');
}
// 全角括号也能配平
{
  const { visible } = await runFilter(['[执行动作:读取仓库文件（{"path":"a"}）]尾']);
  assert.equal(visible, '尾');
}
// 思考块整段隐藏，跨 chunk 也隐藏
{
  const { visible } = await runFilter(['<think>内心', '独白</think>答案']);
  assert.equal(visible, '答案');
}
// 续写标记不展示，且 hasContinueMarker 只认尾部 CONTINUE
{
  const { visible } = await runFilter(['第一段<!--CONTI', 'NUE-->']);
  assert.equal(visible, '第一段');
  assert.ok(hasContinueMarker('正文<!--CONTINUE-->'));
  assert.ok(hasContinueMarker('正文<!-- CONTINUE -->  \n'));
  assert.ok(!hasContinueMarker('正文<!--DONE-->'));
  assert.ok(!hasContinueMarker('<!--CONTINUE-->后面还有正文'));
  assert.ok(hasContinueMarker('正文<!--CONTINUE--><think>x</think>'));
}
// 普通方括号/尖括号正文最终完整可见（flush 后不丢尾巴）
{
  const { visible } = await runFilter(['数组 arr[0] 与 a < b ', '结束']);
  assert.equal(visible, '数组 arr[0] 与 a < b 结束');
}
// 长指令缓冲中通知 UI「编写工具调用中」，收尾后复位
{
  const { holds } = await runFilter(['[执行动作:写入({"path":"x","content":"' + 'a'.repeat(200), '"})]']);
  assert.ok(holds.includes(true));
  assert.equal(holds.at(-1), false);
}
// 未收尾的指令在 flush 时丢弃而不是当正文泄漏
{
  const { visible } = await runFilter(['前文[执行动作:写入({"path":"x","content":"被截断了']);
  assert.equal(visible, '前文');
}

// 截断判定：末尾残留未闭合指令
assert.ok(hasTruncatedDirective('正文[执行动作:写入({"a":"b'));
assert.ok(!hasTruncatedDirective('正文[执行动作:写入({"a":"b"})]'));
assert.ok(!hasTruncatedDirective('[执行动作:A({})]然后[执行动作:B({"x":1})]'));
assert.ok(!hasTruncatedDirective('<think>[执行动作:x(</think>没有指令'));
assert.equal(stripThinkBlocks(' <think>a</think> 正文 '), '正文');

// 上下文回放
const context = [
  { role: 'user', content: '看下文件', images: ['data:image/png;base64,AAAA'], files: [{ name: 'n.txt', content: 'hello' }] },
  { role: 'assistant', content: '我读一下', toolCalls: [{ id: 'c1', name: 'read_repo_file', args: { path: 'a.ts' } }] },
  { role: 'tool', content: 'const a = 1;', toolCallId: 'c1', name: '读取仓库文件' },
  { role: 'assistant', content: '[执行动作:读取仓库文件({"path":"b.ts"})]' },
  { role: 'tool', content: 'const b = 2;', name: '读取仓库文件' },
];
{
  const text = contextToTextMessages(context);
  assert.equal(JSON.stringify(text.map((m) => m.role)), JSON.stringify(['user', 'assistant', 'user', 'assistant', 'user']));
  assert.equal(text[0].content[0].type, 'text');
  assert.ok(text[0].content[0].text.includes('[附件：n.txt]\nhello'));
  assert.equal(text[0].content[1].image_url.url, context[0].images[0]);
  // 原生轮次的调用补写成中文指令，模型在文本协议下能看懂自己做过什么
  assert.equal(text[1].content, '我读一下\n[执行动作:读取仓库文件({"path":"a.ts"})]');
  assert.ok(text[2].content.includes('【读取仓库文件】\nconst a = 1;'));
  assert.equal(text[1].toolCalls, undefined);
}
{
  const native = contextToNativeMessages(context);
  assert.equal(JSON.stringify(native.map((m) => m.role)), JSON.stringify(['user', 'assistant', 'tool', 'assistant', 'user']));
  assert.deepEqual(native[1].toolCalls, context[1].toolCalls);
  assert.equal(native[2].toolCallId, 'c1');
  assert.equal(native[2].name, '读取仓库文件');
  // 文本轮次的结果没有 callId：退化成 user 块而不是不合法的 tool 消息
  assert.ok(native[4].content.includes('const b = 2;'));
  assert.equal(native[3].toolCalls, undefined);
}
// 没有附件/图片的 user 条目保持纯字符串（不无谓升级成多模态）
assert.equal(typeof contextToNativeMessages([{ role: 'user', content: 'hi' }])[0].content, 'string');

console.log('check-qa-engine: ok');
