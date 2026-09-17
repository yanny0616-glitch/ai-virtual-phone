// 记忆提示词迁移 + token 校准的纯逻辑检查（剥类型后在沙箱里跑，不依赖浏览器）
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const load = (file, names) => {
  const src = fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(src).replace(/^import .*$/gm, '').replace(/^export /gm, '') + `\nglobalThis.api={${names}};`, ctx);
  return ctx.api;
};

const types = load('memory-types.ts', 'DEFAULT_MEMORY_CONFIG,DEFAULT_SUMMARIZATION_PROMPT,DEFAULT_CORE_MEMORY_PROMPT,LEGACY_SUMMARIZATION_PROMPT,LEGACY_CORE_MEMORY_PROMPT,migrateMemoryPrompts');

for (const key of ['{{char}}', '{{earliest}}', '{{latest}}', '{{events}}', '{{count}}']) {
  assert.ok(types.DEFAULT_SUMMARIZATION_PROMPT.includes(key), `summary prompt keeps ${key}`);
}
for (const key of ['{{char}}', '{{earliest}}', '{{latest}}', '{{events}}']) {
  assert.ok(types.DEFAULT_CORE_MEMORY_PROMPT.includes(key), `core prompt keeps ${key}`);
}
assert.ok(types.DEFAULT_SUMMARIZATION_PROMPT.includes('普通闲聊'), 'ordinary chat must still be recorded');
assert.ok(/要保留：[\s\S]*要略去/.test(types.DEFAULT_CORE_MEMORY_PROMPT), 'core prompt separates keep / skip');
assert.notEqual(types.DEFAULT_SUMMARIZATION_PROMPT, types.LEGACY_SUMMARIZATION_PROMPT);
console.log('PASS new prompts keep placeholders and rules');

const saved = { ...types.DEFAULT_MEMORY_CONFIG, summarizationPrompt: types.LEGACY_SUMMARIZATION_PROMPT + '\n', coreMemoryPrompt: types.LEGACY_CORE_MEMORY_PROMPT };
let migrated = types.migrateMemoryPrompts(saved);
assert.equal(migrated.summarizationPrompt, types.DEFAULT_SUMMARIZATION_PROMPT, 'saved legacy default (trailing newline) migrates');
assert.equal(migrated.coreMemoryPrompt, types.DEFAULT_CORE_MEMORY_PROMPT);
const custom = { ...saved, summarizationPrompt: types.LEGACY_SUMMARIZATION_PROMPT.replace('100-200字', '300字'), coreMemoryPrompt: '我自己的核心提示词' };
migrated = types.migrateMemoryPrompts(custom);
assert.equal(migrated.summarizationPrompt, custom.summarizationPrompt, 'edited prompt untouched');
assert.equal(migrated.coreMemoryPrompt, '我自己的核心提示词');
console.log('PASS legacy defaults migrate, custom prompts untouched');

const counter = load('token-counter.ts', 'estimateTokens,tokenCalibrationSample,updateTokenCalibration');
assert.equal(counter.estimateTokens('你好世界abcd'), Math.ceil(4 / 1.5 + 4 / 4), 'base formula unchanged');
assert.equal(counter.tokenCalibrationSample(100, 150), null, 'short requests skipped');
assert.equal(counter.tokenCalibrationSample(10000, 50000), null, 'absurd ratio skipped');
let cal;
for (const ratio of [1.4, 1.3, 1.5]) cal = counter.updateTokenCalibration(cal, counter.tokenCalibrationSample(10000, ratio * 10000), 'now');
assert.equal(cal.samples, 3);
assert.ok(Math.abs(cal.ratio - 1.4) < 1e-9, `first samples average (${cal.ratio})`);
for (let i = 0; i < 40; i++) cal = counter.updateTokenCalibration(cal, 1.0, 'now');
assert.ok(Math.abs(cal.ratio - 1.0) < 0.01, 'ratio follows a changed tokenizer');
console.log('PASS token calibration sampling and update');
