import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real page event handler, including name/identifier edits and saving.
const source = fs.readFileSync(new URL('../components/settings/preset-manager.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const onFill = (e: Event) => {');
const end = source.indexOf('window.addEventListener("mascot-fill-field", onFill);', start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + '\nglobalThis.onFill = onFill;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let presets;
let saved;
const ctx = vm.createContext({
  editingIdRef: { current: 'preset' },
  MASCOT_PRESET_STORAGE_TOOL_NAMES: new Set(),
  matchMarkerByName: name => name === '角色定义' ? 'charDescription' : null,
  setPresets: fn => { presets = fn(presets); },
  savePresets: value => { saved = value; },
});
vm.runInContext(code, ctx);
const clone = value => JSON.parse(JSON.stringify(value));
const prompt = id => ({ identifier: id, name: id, role: 'system', content: 'original', enabled: true });
const fill = (field, value) => ctx.onFill({ detail: { field, value } });
const order = () => clone(saved[0].prompt_order);
const reset = () => { presets = [{ id: 'preset', prompts: [prompt('a'), prompt('b'), prompt('c')], prompt_order: [
  { identifier: 'c', enabled: false }, { identifier: 'a', enabled: true }, { identifier: 'b', enabled: false },
] }]; saved = null; };
reset();
const before = clone(presets);
fill('prompt_0_content', 'edited');
assert.deepEqual(order(), before[0].prompt_order);
assert.equal(saved[0].prompts[0].content, 'edited');
assert.equal(before[0].prompts[0].content, 'original');
fill('prompt_2_identifier', 'renamed');
assert.deepEqual(order(), [{ identifier: 'renamed', enabled: false }, ...before[0].prompt_order.slice(1)]);
fill('prompt_2_name', '角色定义');
assert.equal(order()[0].identifier, 'charDescription');
assert.equal(order()[0].enabled, false);
fill('prompt_3_content', 'new entry');
assert.equal(order().at(-1).identifier, 'prompt_3');
assert.equal(order().at(-1).enabled, true);
assert.equal(order()[0].enabled, false);
reset();
presets[0].prompts.push(prompt('_placeholder_4'), prompt('orphan'));
presets[0].prompt_order.push({ identifier: 'c', enabled: true }, { identifier: 'deleted', enabled: true }, { identifier: '_placeholder_4', enabled: true });
fill('prompt_0_content', 'edited');
assert.deepEqual(order(), [...before[0].prompt_order, { identifier: 'orphan', enabled: true }]);
reset();
delete presets[0].prompt_order;
fill('prompt_0_content', 'edited');
assert.deepEqual(order().map(x => x.identifier), ['a', 'b', 'c']);
console.log('PASS: page fill preserves order and toggles, maps renamed entries, appends new entries and removes invalid order entries.');
