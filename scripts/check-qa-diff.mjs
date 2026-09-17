// 提案卡 diff 纯函数回归
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(fs.readFileSync(new URL('../lib/qa-diff.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
const ctx = vm.createContext({ Uint32Array, Math });
vm.runInContext(`${source};globalThis.diff=computeQaLineDiff`, ctx);
const diff = ctx.diff;
const J = (v) => JSON.stringify(v);

// 单处修改：一个 hunk，前后各 3 行上下文
{
  const a = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const b = a.replace('line5', 'LINE5');
  const d = diff(a, b);
  assert.equal(d.added, 1); assert.equal(d.removed, 1); assert.equal(d.hunks.length, 1);
  assert.equal(d.hunks[0].oldStart, 3); assert.equal(d.hunks[0].newStart, 3);
  assert.equal(J(d.hunks[0].lines.map((l) => l.kind)), J(['same','same','same','del','add','same','same','same']));
}
// 相隔很远的两处修改：两个 hunk；挨得近的合并成一个
{
  const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
  const far = [...lines]; far[2] = 'X'; far[30] = 'Y';
  assert.equal(diff(lines.join('\n'), far.join('\n')).hunks.length, 2);
  const near = [...lines]; near[10] = 'X'; near[13] = 'Y';
  assert.equal(diff(lines.join('\n'), near.join('\n')).hunks.length, 1);
}
// 新文件：全 add，行号从 1 起；相同内容：无 hunk
{
  const d = diff('', 'a\nb\n');
  assert.equal(d.added, 2); assert.equal(d.removed, 0); assert.equal(d.hunks[0].newStart, 1);
  assert.equal(diff('a\nb\n', 'a\nb\n').hunks.length, 0);
}
// 尾部换行差异不算改动；纯追加只有 add
{
  assert.equal(diff('a\nb', 'a\nb\n').added, 0);
  const d = diff('a\nb\n', 'a\nb\nc\n');
  assert.equal(d.added, 1); assert.equal(d.removed, 0);
}
// 超大文件不做 LCS
{
  const big = Array.from({ length: 4001 }, (_, i) => String(i)).join('\n');
  assert.equal(diff(big, big + '\nx').tooLarge, true);
}
console.log('check-qa-diff: ok');
