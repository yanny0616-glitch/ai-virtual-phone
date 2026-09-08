import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const testModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: testModule, exports: testModule.exports, require: id => { if (id === './widget-types') return load('lib/widget-types.ts'); throw Error('Unexpected import ' + id); }, Intl, console });
  modules.set(file, testModule.exports); return testModule.exports;
}
const D = load('lib/mascot-edit-domain.ts');
const plain = x => JSON.parse(JSON.stringify(x));
let seq = 0;
const env = { now: '2026-09-07T16:00:00Z', uid: () => String(++seq), knownIcons: ['music', 'chat', 'settings', 'calendar'] };
const initial = () => ({
  characters: [{ id:'a', name:'同名', persona:'原人设', personality:'温柔', tags:['现代'], avatar:null, createdAt:'old', updatedAt:'old' }, { id:'b', name:'同名', persona:'另一角色', avatar:null, createdAt:'old', updatedAt:'old' }],
  templates: [{id:'diy-a', name:'天气', size:'2x2', mode:'code', htmlString:'<script>fetch("weather");</script><h1>原卡</h1>'}],
  desktop: { layout:{page1:[{id:'music',row:5,col:1},{id:'chat',row:5,col:2}],page2:[]}, dock:['settings','calendar'], folders:{}, widgets:[{id:'w1',type:'diy-a',size:'2x2',page:1,row:1,col:1,config:{city:'上海',image:'user-photo'}},{id:'w2',type:'diy-a',size:'2x2',page:1,row:1,col:3}] },
  appearance:{name:'旧主题',wallpaperAssetId:null,wallpaperBlur:0,wallpaperOpacity:1,wallpaperScale:1,wallpaperX:50,wallpaperY:50,wallpaperLibrary:[],iconSkins:{},iconSchemes:[],activeIconSchemeId:'',cssOverrides:{'--old':'yes'},globalCustomCSS:'.old{}',updatedAt:'old'},
});
const token = (s, scope, id) => ({scope,...(id?{id}:{}),revision:D.editRevision(D.editScopeValue(s,scope,id))});
const plan = (s, ops) => D.planEdits(s,ops,[...new Map(ops.map(op=>{const r=D.requiredEditScope(op);return [r.scope+':'+r.id,token(s,r.scope,r.id)];})).values()],env,'测试');
let s=initial(); const original=plain(s);
let p=plan(s,[{action:'character.update',id:'b',patch:{addTags:['配角','配角'],timeZone:'Asia/Shanghai'}}]);
assert.deepEqual(s, original, 'planning mutated input');
let next=D.applyEditDeltas(s,p.deltas);
assert.deepEqual(plain(next.characters[0]),s.characters[0]); assert.deepEqual(plain(next.characters[1].tags),['配角']);
assert.equal(next.characters[1].persona,'另一角色');
next.characters[0].persona='用户修改另一个角色';
const undone=D.applyEditDeltas(next,p.deltas,true);assert.equal(undone.characters[0].persona,'用户修改另一个角色');assert.deepEqual(plain(undone.characters[1]),s.characters[1]);
next.characters[1].persona='后续改动';assert.throws(()=>D.applyEditDeltas(next,p.deltas,true),/之后已被修改/);
assert.throws(()=>D.planEdits(s,[{action:'character.update',id:'a',patch:{name:'x'}}],[{scope:'character',id:'a',revision:'old'}],env,'x'),/重新读取/);
assert.throws(()=>plan(s,[{action:'character.update',id:'a',patch:{timeZone:'Mars/City'}}]),/时区/);
assert.throws(()=>plan(s,[{action:'character.update',id:'a',patch:{unknown:'bad'}}]),/不支持修改/);
assert.throws(()=>plan(s,[{action:'character.update',id:'a',patch:{avatar:'javascript:bad'}}]),/头像/);
p=plan(s,[{action:'character.update',id:'a',patch:{addTags:['配角'],removeTags:['现代']}}]);assert.deepEqual(plain(D.applyEditDeltas(s,p.deltas).characters[0].tags),['配角']);
p=plan(s,[{action:'widget.update',id:'w1',templatePatch:{name:'我的新款',htmlString:'<p>新版</p>'},patch:{config:{city:'北京'}}}]);next=D.applyEditDeltas(s,p.deltas);
assert.equal(next.desktop.widgets[1].type,'diy-a');assert.notEqual(next.desktop.widgets[0].type,'diy-a');assert.equal(next.templates[0].htmlString,s.templates[0].htmlString);assert.equal(next.desktop.widgets[0].config.image,'user-photo');
assert.deepEqual(plain(D.applyEditDeltas(next,p.deltas,true)),s);
assert.throws(()=>plan(s,[{action:'template.update',id:'diy-a',patch:{size:'2x4'}}]),/重叠/);assert.deepEqual(s,original);
p=plan(s,[{action:'desktop.arrange',patch:{layout:{page1:[{id:'chat',row:5,col:1},{id:'music',row:5,col:2}],page2:[]},placements:[{id:'w1',page:1,row:1,col:3},{id:'w2',page:1,row:1,col:1}]}}]);next=D.applyEditDeltas(s,p.deltas);assert.equal(next.desktop.widgets[0].col,3);assert.equal(next.desktop.layout.page1[0].id,'chat');
p=plan(s,[{action:'desktop.arrange',patch:{layout:{page1:[{id:'folder:test',row:5,col:1},{id:'settings',row:6,col:1}],page2:[]},dock:['calendar'],folders:{'folder:test':{name:'常用',icons:['music','chat']}}}}]);next=D.applyEditDeltas(s,p.deltas);assert.equal(next.desktop.folders['folder:test'].icons.length,2);assert.deepEqual(plain(D.applyEditDeltas(next,p.deltas,true)),s);
assert.throws(()=>plan(s,[{action:'desktop.arrange',patch:{layout:{page1:[],page2:[]}}}]),/保留所有/);
assert.throws(()=>plan(s,[{action:'widget.update',id:'w1',patch:{row:1.2}}]),/整数/);
assert.throws(()=>plan(s,[{action:'widget.place',type:'diy-a',row:6,col:4}]),/需要/);
p=plan(s,[{action:'widget.place',type:'diy-a',page:2}]);next=D.applyEditDeltas(s,p.deltas);assert.equal(next.desktop.widgets.at(-1).page,2);
p=plan(s,[{action:'appearance.update',patch:{cssOverrides:{'--new':'ok'}}}]);next=D.applyEditDeltas(s,p.deltas);assert.equal(next.appearance.cssOverrides['--old'],'yes');assert.equal(next.appearance.globalCustomCSS,'.old{}');
assert.throws(()=>plan(s,[{action:'character.update',id:'a',patch:{addTags:['配角']}},{action:'widget.update',id:'missing',patch:{row:2}}]),/找不到/);assert.deepEqual(s,original);
p=plan(s,[{action:'template.update',id:'diy-a',patch:{htmlEdits:[{find:'<h1>原卡</h1>',replace:'<h1>新标题</h1>'}]}}]);next=D.applyEditDeltas(s,p.deltas);assert.match(next.templates[0].htmlString,/fetch\("weather"\)/);assert.match(next.templates[0].htmlString,/新标题/);
assert.throws(()=>plan(s,[{action:'template.update',id:'diy-a',patch:{htmlEdits:[{find:'不存在',replace:'新'}]}}]),/恰好匹配一次/);
const ambiguous=initial();ambiguous.templates[0].htmlString='<p>x</p><p>x</p>';assert.throws(()=>plan(ambiguous,[{action:'template.update',id:'diy-a',patch:{htmlEdits:[{find:'<p>x</p>',replace:'new'}]}}]),/恰好匹配一次/);
const book={name:'世界书',description:'说明',entries:[{uid:'entry-a',key:'线索',content:'原有设定',comment:'备注',use_regex:false,disable:false,constant:true,position:'before_char',insertion_order:1}]};
p=plan(s,[{action:'character.update',id:'a',patch:{embeddedWorldBook:book}}]);assert.deepEqual(plain(D.applyEditDeltas(s,p.deltas).characters[0].embeddedWorldBook),book);
console.log('PASS edit domain: ID isolation, tags, stale reads, batch atomic planning, exact undo/conflicts, single-instance clone/config preservation, resize collision, swap/cross-page/folder/Dock, appearance merge, invalid inputs.');

// Actual store and tool routing with a failure-injectable storage adapter.
// The browser companion separately verifies the real IndexedDB transaction.
const cache=new Map(); const clone=x=>JSON.parse(JSON.stringify(x));
let failWrite=false, writes=0;
const stored=(key,fallback)=>cache.has(key)?JSON.parse(cache.get(key)):clone(fallback);
const base=initial();
const K={chars:'ai_phone_characters_v1',templates:'ai_phone_diy_templates_v1',widgets:'ai_phone_widgets_v1',layout:'ai_phone_icon_layout_v2',dock:'ai_phone_dock_layout_v1',folders:'ai_phone_desktop_folders_v1',appearance:'ai_phone_theme_profile_v1'};
for(const [key,value] of [[K.chars,base.characters],[K.templates,base.templates],[K.widgets,base.desktop.widgets],[K.layout,base.desktop.layout],[K.dock,base.desktop.dock],[K.folders,base.desktop.folders],[K.appearance,base.appearance]])cache.set(key,JSON.stringify(value));
const emitted=[];
const kv={kvGet:key=>cache.get(key)??null,registerKvMigration:()=>{},kvCompareAndSetBatch:async changes=>{for(const c of changes)assert.equal(kv.kvGet(c.key),c.expected);if(failWrite)throw Error('disk unavailable');for(const c of changes)cache.set(c.key,c.value);writes++;}};
const mocks={
  './kv-db':kv,
  './character-storage':{loadCharacters:()=>stored(K.chars,[]),invalidateCharacterCache:()=>{}},
  './widget-storage':{loadWidgets:()=>stored(K.widgets,[]),loadDIYTemplates:()=>stored(K.templates,[])},
  './desktop-layout-storage':{ICON_LAYOUT_STORAGE_KEY:K.layout,DOCK_LAYOUT_STORAGE_KEY:K.dock,DESKTOP_FOLDERS_STORAGE_KEY:K.folders,loadDockLayout:()=>stored(K.dock,[]),loadDesktopFolders:()=>stored(K.folders,{}),normalizeDesktopIconLayout:v=>v},
  './theme-storage':{readThemeProfile:()=>stored(K.appearance,{}),THEME_PROFILE_STORAGE_KEY:K.appearance,collectThemeAssetIds:()=>[],getThemeAssetDataUrl:async()=>'data:image/png;base64,AA=='},
  './theme-types':{normalizeThemeProfile:v=>v},
  './desktop-config':{ICONS:Object.fromEntries(env.knownIcons.map(id=>[id,{id,label:id}]))},
  './custom-app-storage':{loadInstalledCustomApps:()=>[]},
  './widget-types':load('lib/widget-types.ts'), './mascot-edit-domain':D,
  './css-asset-tools':{}, './mascot-prompts':{},
};
const runtimeModules={};
function runtime(file){
  if(runtimeModules[file])return runtimeModules[file];
  const testModule={exports:{}};
  vm.runInNewContext(ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module:testModule,exports:testModule.exports,console,Intl,crypto:{randomUUID:()=>String(++seq)},window:{dispatchEvent:e=>emitted.push(e.type)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
    require:id=>{if(id in mocks)return mocks[id];if(id.startsWith('./mascot-edit-'))return runtime('lib/'+id.slice(2)+'.ts');throw Error('Unexpected runtime dependency '+id);},
  });runtimeModules[file]=testModule.exports;return testModule.exports;
}
mocks['./character-version-storage']=runtime('lib/character-version-storage.ts');
const store=runtime('lib/mascot-edit-store.ts');
const roleRead=store.readEditObject('character','a');assert.deepEqual(plain(roleRead.character.tags),['现代']);
const draft=await store.prepareEdit([{action:'character.update',id:'a',patch:{addTags:['配角']}}],[roleRead.read],'添加配角标签');
assert.equal(store.readEditState().characters[0].tags.length,1,'draft wrote role');
assert.equal(store.readEditJournal()[0].status,'draft');
failWrite=true;const journalBefore=kv.kvGet('ai_phone_mascot_edits_v1');await assert.rejects(store.commitEdit(draft.id),/disk unavailable/);assert.equal(kv.kvGet('ai_phone_mascot_edits_v1'),journalBefore);assert.equal(store.readEditState().characters[0].tags.length,1);
failWrite=false;await store.commitEdit(draft.id);assert.deepEqual(plain(store.readEditState().characters[0].tags),['现代','配角']);const written=writes;await store.commitEdit(draft.id);assert.equal(writes,written,'retry duplicated write');
assert.ok(emitted.includes('mascot-edit-changed'));
assert.equal(stored('ai_phone_character_versions_v1',{}).a.versions[0].data.persona,'原人设');
assert.equal(stored('ai_phone_character_versions_v1',{}).a.currentVersion,2);
const roles=stored(K.chars,[]);roles[1].persona='用户改另一张';cache.set(K.chars,JSON.stringify(roles));await store.commitEdit(draft.id,true);assert.equal(store.readEditState().characters[1].persona,'用户改另一张');assert.deepEqual(plain(store.readEditState().characters[0].tags),['现代']);
const staleRead=store.readEditObject('character','a');const stalePlan=await store.prepareEdit([{action:'character.update',id:'a',patch:{name:'新名'}}],[staleRead.read],'改名');const changed=stored(K.chars,[]);changed[0].persona='用户后改';cache.set(K.chars,JSON.stringify(changed));await assert.rejects(store.commitEdit(stalePlan.id),/变化/);
const source=store.readDiyEditObject({widgetId:'w1',offset:0,limit:10});assert.equal(source.template.htmlString.length,10);assert.equal(source.nextOffset,10);assert.equal(source.selectedInstance.config.city,'上海');
const tools=runtime('lib/mascot-edit-tools.ts'); const ctx={pageContext:{}};
await assert.rejects(tools.runMascotEditTool({name:'读取角色',args:{name:'同名'}},ctx),/同名/);
await tools.runMascotEditTool({name:'读取角色',args:{id:'b'}},ctx);
const legacy=await tools.runMascotEditTool({name:'更新角色字段',args:{id:'b',field:'addTags',value:['配角']}},ctx);assert.equal(legacy.success,true);assert.ok(JSON.parse(legacy.data).id);assert.deepEqual(plain(store.readEditState().characters[1].tags),['配角']);
await assert.rejects(tools.runMascotEditTool({name:'更新角色字段',args:{id:'b',field:'name',value:'不能盲写'}},ctx),/重新读取/);
// Real registry aliases and tool definitions for both protocols.
const registry=runtime('lib/mascot-tools.ts');
for(const pkg of registry.MASCOT_TOOL_PACKAGES){assert.match(registry.getMascotNativeLoaderName(pkg.id),/^[a-z0-9_]+$/);for(const tool of pkg.subTools)assert.match(registry.getMascotNativeToolName(tool.name),/^[a-z0-9_]+$/);}
await tools.runMascotEditTool({name:'读取角色',args:{id:'b'}},ctx);
await tools.runMascotEditTool({name:'更新角色字段',args:{id:'b',field:'addTags',value:'["新增标签"]'}},ctx);assert.deepEqual(plain(store.readEditState().characters[1].tags),['配角','新增标签']);
const stringPatch=plan(s,[{action:'character.update',id:'a',patch:JSON.stringify({addTags:['原生工具']})}]);assert.deepEqual(plain(D.applyEditDeltas(s,stringPatch.deltas).characters[0].tags),['现代','原生工具']);
const defs=registry.getMascotNativeToolDefinitions(['editing_pack','character_pack']);assert.ok(defs.some(d=>d.name==='mascot_prepare_edit'));
const routed=await registry.executeMascotToolCall({name:'读取角色',args:{id:'a'}},{pageContext:{}});assert.equal(routed.success,true);assert.equal(JSON.parse(routed.data).character.persona,'用户后改');
console.log('PASS actual store/tool/registry: persisted drafts, disk failure without partial writes, retry idempotence, undo preserves unrelated roles, stale apply, source paging/config, legacy ID/tag routing/read-before-write, native aliases.');

const oldAppearance=stored(K.appearance,{});oldAppearance.wallpaperAssetId='missing-old';cache.set(K.appearance,JSON.stringify(oldAppearance));
mocks['./theme-storage'].getThemeAssetDataUrl=async()=>null;
const appearanceRead=store.readEditObject('appearance');
await store.prepareEdit([{action:'appearance.update',patch:{globalCustomCSS:'.new{}'}}],[appearanceRead.read],'只改 CSS');
await assert.rejects(store.prepareEdit([{action:'appearance.update',patch:{wallpaperAssetId:'missing-new'}}],[appearanceRead.read],'缺失素材'),/找不到外观素材/);
console.log('PASS asset validation: unchanged missing assets do not block unrelated edits; new missing assets rejected before draft persistence.');
