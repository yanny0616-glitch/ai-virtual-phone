import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root=process.cwd(),cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,structuredClone,require:s=>load(path.resolve(path.dirname(file),s+'.ts'))},{filename:file});return exports;
}
const {diffPresetEntries,syncPresetEntries}=load(path.join(root,'lib/preset-entry-sync.ts'));
const plain=v=>JSON.parse(JSON.stringify(v));
const declarations=JSON.parse(fs.readFileSync('custom-apps/gua-nian/presets.json','utf8')).presets;
const prompts=declarations.map(p=>({...p,identifier:'custom_app_gua_nian_prompt_'+p.id,role:'system',injection_depth:0}));
const source={id:'builtin',name:'默认预设（内置）',builtIn:true,prompts,prompt_order:prompts.map(p=>({identifier:p.identifier,enabled:true}))};
const target={...structuredClone(source),id:'custom',name:'我的预设',builtIn:false,temperature:0.73,
 prompts:prompts.slice(0,3).map(p=>({...p,injection_depth:4,content:p.id==='guanian-impulse'?'旧版：只输出 decisions':p.content})),
 prompt_order:prompts.slice(0,3).reverse().map(p=>({identifier:p.identifier,enabled:false}))};
target.prompts[1].enabled=false;
target.prompts.push({identifier:'user-extra',name:'我自己的条目',content:'不覆盖我',role:'system',enabled:true,injection_depth:3});
const snapshot=JSON.stringify([source,target]);
let diff=diffPresetEntries(target,source);
assert.equal(diff.entries.length,5);assert.equal(diff.entries.filter(e=>e.kind==='missing').length,2);
const impulse=prompts[1].identifier,edit=prompts[3].identifier;
assert.deepEqual(plain(diff.entries.find(e=>e.identifier===impulse).fields),['content','injection_depth']);
const result=syncPresetEntries(target,source,[impulse,edit]);
assert.equal(result.added.length,1);assert.equal(result.updated.length,1);
assert.equal(result.preset.prompts.find(p=>p.identifier===impulse).content,prompts[1].content);
assert.equal(result.preset.prompts.find(p=>p.identifier===impulse).injection_depth,0);
assert.equal(result.preset.prompts.find(p=>p.identifier===impulse).enabled,false);
assert.equal(result.preset.prompt_order.find(p=>p.identifier===impulse).enabled,false);
assert.equal(result.preset.prompts[0].injection_depth,4,'unselected differences preserved');
assert.ok(!result.preset.prompts.some(p=>p.identifier===prompts[4].identifier),'unselected missing entry stays absent');
assert.equal(result.preset.prompts.find(p=>p.identifier==='user-extra').content,'不覆盖我');
assert.equal(result.preset.temperature,0.73);
assert.deepEqual(plain(result.preset.prompt_order.filter(p=>target.prompt_order.some(old=>old.identifier===p.identifier))),target.prompt_order);
assert.equal(JSON.stringify([source,target]),snapshot);
assert.equal(syncPresetEntries(target,source,[]).preset,target);
console.log('PASS installed app entries: missing and changed, selected only, no mutation, toggles/order/settings retained');

const equivalent={...structuredClone(source),id:'equivalent'};
equivalent.prompts[0].enabled=false;equivalent.prompt_order.reverse();equivalent.prompt_order[0].enabled=false;
equivalent.prompts[1].tags.reverse();
assert.equal(diffPresetEntries(equivalent,source).entries.length,0);
const legacy={...structuredClone(source),id:'legacy'};legacy.prompts[0].tags=undefined;legacy.prompts[0].featureTag='companion';
const modern={...structuredClone(source)};modern.prompts[0].tags=['companion'];
assert.equal(diffPresetEntries(legacy,modern).entries.length,0);
const refreshed={...structuredClone(target)};refreshed.prompts[1].content='预览后又修改了';
assert.notEqual(diffPresetEntries(refreshed,source).entries.find(e=>e.identifier===impulse).reviewKey,diff.entries.find(e=>e.identifier===impulse).reviewKey);
const toggled=structuredClone(target);toggled.prompts[1].enabled=true;
assert.equal(diffPresetEntries(toggled,source).entries.find(e=>e.identifier===impulse).reviewKey,diff.entries.find(e=>e.identifier===impulse).reviewKey);
console.log('PASS comparison ignores toggle/order/tag ordering; reviewed content detects concurrent edits');

const dup=structuredClone(target);dup.prompts.push({...dup.prompts[1]});
assert.ok(!diffPresetEntries(dup,source).entries.some(e=>e.identifier===impulse));
assert.equal(diffPresetEntries(dup,source).warnings.length,1);
const collision=structuredClone(target);collision.prompts.push({...prompts[3],identifier:'my-other-id'});
assert.ok(diffPresetEntries(collision,source).warnings.some(w=>w.includes('同名')));
assert.equal(syncPresetEntries(collision,source,[edit]).preset.prompts.filter(p=>p.name===prompts[3].name).length,2);
const orphan=structuredClone(target);orphan.prompt_order.push({identifier:edit,enabled:false});
const repaired=syncPresetEntries(orphan,source,[edit]).preset;
assert.equal(repaired.prompt_order.filter(p=>p.identifier===edit).length,1);
assert.equal(repaired.prompt_order.find(p=>p.identifier===edit).enabled,true);
console.log('PASS duplicate IDs blocked, name collision disclosed, orphan order repaired without duplication');

const position={...structuredClone(source),id:'position',prompts:[prompts[0],prompts[4]],prompt_order:[{identifier:prompts[0].identifier,enabled:true},{identifier:prompts[4].identifier,enabled:false}]};
const inserted=syncPresetEntries(position,source,[prompts[1].identifier,prompts[2].identifier,prompts[3].identifier]);
assert.deepEqual(plain(inserted.preset.prompt_order.map(p=>p.identifier)),prompts.map(p=>p.identifier));
assert.equal(inserted.preset.prompt_order.at(-1).enabled,false);
console.log('PASS missing entries follow built-in relative placement without reordering existing entries');
