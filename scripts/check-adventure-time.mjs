import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
import { randomUUID } from "node:crypto";
const read = file => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
function load(file, deps = {}) {
  const testModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS} }).outputText,
    {module:testModule,exports:testModule.exports,structuredClone,console,require:id=>{if(!(id in deps))throw Error("Missing stub "+id);return deps[id];}}, {filename:file});
  return testModule.exports;
}
const D=load("lib/adventure-time.ts");
const base=()=>({id:"s",worldId:"w",gameDay:1,gameTime:"morning",journal:[],hp:100,maxHp:100,agents:[],playerStats:{},director:{mainArc:{currentStage:0,stageResults:[]},keyItems:[],keyNpcsMet:[],worldChanges:[],plantedClues:[]},keyChoices:[],mainQuestStage:0,currentNodeId:"l1_0",currentNodeType:"l1",discoveredNodes:[],visitedNodes:[],usedEncounterIds:[]});
const from={day:1,period:"morning"};
const update={from,to:{day:1,period:"afternoon"},reason:"处理了一上午公事"};
const context={expected:from,turnId:"turn1",createdAt:"2026-09-09T12:00:00Z",locationName:"紫光殿"};
const old=base();const original=JSON.stringify(old);
let advanced=D.applyAdventureTime(old,update,context).save;
assert.equal(advanced.gameTime,"afternoon");assert.equal(advanced.gameDay,1);
assert.match(advanced.journal[0].timestamp,/午后/);assert.match(advanced.journal[0].text,/一上午公事/);
assert.equal(JSON.stringify(old),original);
assert.equal(D.applyAdventureTime(advanced,update,context).save,advanced,"same successful turn cannot advance twice");
const same={...update,to:from};
assert.equal(D.applyAdventureTime(old,same,context).save.gameTime,"morning");
for(const raw of [null,undefined]){const s=D.applyAdventureTime(old,raw,context).save;assert.equal(s.gameTime,"morning");assert.equal(s.journal.length,0);assert.equal(s.lastTimeTurnId,"turn1");}
for(const raw of [true,[],{}, {...update,from:{day:2,period:"morning"}}, {...update,to:{day:0,period:"night"}}, {...update,to:{day:1.5,period:"night"}}, {...update,to:{day:1,period:"midnight"}}, {...update,to:{day:NaN,period:"night"}}, {...update,to:{day:"2",period:"night"}}, {...update,reason:""}, {...update,reason:"x".repeat(501)}]){
 const r=D.applyAdventureTime(old,raw,context);assert.equal(r.save.gameTime,"morning");assert.equal(r.save.journal.length,0);assert.ok(r.warning);
}
const afternoon={...old,gameTime:"afternoon"};
assert.match(D.applyAdventureTime(afternoon,{from:{day:1,period:"afternoon"},to:from,reason:"倒流"},{...context,expected:{day:1,period:"afternoon"}}).warning,/倒退/);
assert.equal(D.applyAdventureTime({...old,gameDay:2},update,context).save.gameDay,2,"stale request cannot overwrite rest");
const overnight=D.applyAdventureTime({...old,gameTime:"night"},{from:{day:1,period:"night"},to:{day:2,period:"morning"},reason:"睡了一夜"},{...context,expected:{day:1,period:"night"}}).save;
assert.equal(overnight.gameDay,2);assert.equal(overnight.gameTime,"morning");
assert.equal(D.applyAdventureTime(old,{...update,to:{day:5,period:"evening"},reason:"经过四日旅途"},context).save.gameDay,5);
const restored=JSON.parse(JSON.stringify(advanced));assert.equal(D.applyAdventureTime(restored,update,context).save,restored);
assert.match(D.adventureTimeInstruction(from),/不按消息数量/);
console.log("PASS time domain: no-op dialogue, all period/day validation, overnight/multiple days, no backwards/stale writes, reason journal, immutable input, duplicate/reload guard.");

// Actual DM adapters: the protocol also works with custom scene/resolve prompts.
let reply={content:JSON.stringify({narration:"忙完事务，已是午后。",choices:[{label:"继续"}],journal:"处理完公事。",time_update:update})};const calls=[];
const deps={};for(const m of read("lib/map-rpg-engine.ts").matchAll(/from ["']([^"']+)["']/g))deps[m[1]]={};
Object.assign(deps,{"./adventure-time":D,"./adventure-status":load("lib/adventure-status.ts"),"./adventure-world-edit":load("lib/adventure-world-edit.ts"),
 "./api-helpers":{simpleLLMCall:async(_api,messages)=>{calls.push(messages);return reply;}},
 "./map-storage":{getMapWorld:()=>null,loadDMPrompts:()=>({scene:"自定义场景",resolve:"自定义裁决"}),loadDMTokenConfig:()=>({})},
 "./token-counter":{estimateTokens:s=>s.length},"./user-macro":{renderUserNameMacro:s=>s,normalizeUserNameToMacro:s=>s}});
const E=load("lib/map-rpg-engine.ts",deps);
const ctx={clock:from,gameTime:"第1天 · 清晨",worldLore:"宫廷",currentLocation:"紫光殿",eventType:"talk",eventBrief:"公事",companionNames:[],recentJournal:[],keyChoices:[]};
const scene=await E.expandEvent(ctx,[],{});const resolved=await E.resolveRound(ctx,[],{});
assert.deepEqual(JSON.parse(JSON.stringify(scene.timeUpdate)),update);assert.deepEqual(JSON.parse(JSON.stringify(resolved.timeUpdate)),update);
for(const messages of calls){assert.match(messages[0].content,/time_update/);assert.match(messages[1].content,/本轮开始的游戏时间/);}
reply={content:JSON.stringify({narration:"已至午后",time_update:update}),wasTruncated:true};
assert.ok(D.applyAdventureTime(old,(await E.expandEvent(ctx,[],{})).timeUpdate,context).warning);
reply={content:JSON.stringify({narration:"已至午后",time_update:update}).replace(/}$/,",}")};
assert.ok(D.applyAdventureTime(old,(await E.resolveRound(ctx,[],{})).timeUpdate,context).warning);
reply={content:null,error:"连接失败"};await assert.rejects(E.resolveRound(ctx,[],{}));
console.log("PASS DM protocol: scene + resolve carry exact absolute clocks, custom prompts retain protocol, repaired/truncated responses cannot advance, API failures throw.");

// Execute the actual React callbacks in an isolated event-handler environment.
// No React rendering or implementation-mirroring reimplementation of the handlers.
const source=ts.createSourceFile("map-view.tsx",read("components/map/map-view.tsx"),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
const handlers=new Map();
function visit(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(source)==="useCallback")handlers.set(node.name.text,node.initializer.arguments[0].getText(source));ts.forEachChild(node,visit);}visit(source);
function envFor(save=base()){
 const environment={console,crypto:{randomUUID},setTimeout:()=>1,world:{id:"w"},worldEditorBusyRef:{current:false},save,saveRef:{current:save},timeTurnIdRef:{current:save.pendingEvent?.timeTurnId},
 inEvent:false,eventLoading:false,eventContinueLoading:false,eventContext:JSON.stringify(ctx),activeEventMeta:{type:"talk"},characters:[],userIdentity:{name:"玩家"},currentNode:{name:"紫光殿",type:"l1"},allNodes:[],
 skeleton:{world:{name:"大燕",lore:"宫廷"},mainQuest:{stages:[],synopsis:""},sideQuests:[],npcs:[],richRegions:[]},streamRef:{current:[]},completedCompanionsRef:{current:[]},lastFailedActionRef:{current:null},
 loadApiConfigs:()=>[{id:"api",apiKey:"fixture"}],loadBindingConfig:()=>({}),resolveBinding:()=>({}),formatGameTime:E.formatGameTime,readAdventureClock:D.readAdventureClock,applyAdventureTime:D.applyAdventureTime,
 shouldAutoSummarize:()=>false,charName:id=>id,mkId:randomUUID,pushSceneToStream:()=>{},applySceneStatus:s=>s,pushMessages:()=>{},};
 for(const match of read("components/map/map-view.tsx").matchAll(/\b(set[A-Z]\w*)\(/g)) {const name=match[1];if(name==="setTimeout")continue;const key=name[3].toLowerCase()+name.slice(4);environment[name]=value=>{environment[key]=typeof value==="function"?value(environment[key]):value;};}
 environment.messages=[];environment.pushMessages=(...msgs)=>environment.messages.push(...msgs);
 environment.persistSave=s=>{environment.saveRef.current={...s,pendingEvent:{timeTurnId:environment.timeTurnIdRef.current}};environment.save=environment.saveRef.current;};
 environment.seen=[];
 const model=async c=>{environment.seen.push(structuredClone(c));if(environment.fail)throw Error("API失败");return structuredClone(environment.response);};
 environment.expandEvent=model;environment.resolveRound=model;
 environment.response={...JSON.parse(JSON.stringify(scene)),journalEntry:"公事已毕。"};
 vm.createContext(environment);
 for(const name of ["applySceneTime","triggerEvent","handlePlayerAction","handleDirectResolve","handleRest"])vm.runInContext(ts.transpileModule(`globalThis.${name}=${handlers.get(name)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,environment);
 return environment;
}
for(const kind of ["trigger","normal","direct"]){
 const h=envFor();h.inEvent=kind!=="trigger";
 if(kind==="trigger")await h.triggerEvent("talk","处理公事");
 if(kind==="normal")await h.handlePlayerAction("处理公事");
 if(kind==="direct")await h.handleDirectResolve();
 assert.ok(!h.messages.some(m=>/失败|发生错误/.test(m.text)),kind+" handler failed unexpectedly");
 assert.equal(h.saveRef.current.gameTime,"afternoon",kind+" must persist time");
 assert.ok(h.saveRef.current.journal.every(j=>j.timestamp.includes("午后")),kind+" journal must use updated time");
 assert.equal(h.seen[0].clock.period,"morning");
 if(kind==="normal"){
  const first=h.saveRef.current;const count=first.journal.filter(j=>j.id.endsWith("_time")).length;
  await h.handlePlayerAction("处理公事",true,true);
  assert.equal(h.saveRef.current.journal.filter(j=>j.id.endsWith("_time")).length,count,"retry must not duplicate time record");
  const previousTurn=h.saveRef.current.lastTimeTurnId;
  h.response.timeUpdate={from:{day:1,period:"afternoon"},to:{day:1,period:"evening"},reason:"一下午的调查"};
  await h.handlePlayerAction("掷骰后行动",true);
  assert.equal(h.saveRef.current.gameTime,"evening","dice skipDisplay is a NEW time turn");
  assert.notEqual(h.saveRef.current.lastTimeTurnId,previousTurn);
 }
}
const failed=envFor();failed.inEvent=true;failed.fail=true;await failed.handlePlayerAction("处理公事");assert.equal(failed.saveRef.current.gameTime,"morning");assert.equal(failed.saveRef.current.lastTimeTurnId,undefined);
const rest=envFor({...base(),gameTime:"night",gameDay:4});rest.handleRest();assert.equal(rest.saveRef.current.gameDay,5);assert.equal(rest.saveRef.current.gameTime,"morning");
console.log("PASS actual view callbacks: initial scene, normal + direct resolve, journal timestamps, retry vs dice turn IDs, failed request, next-morning rest.");

// Verify the real persistence callback carries the retry identity through a reload.
const persisted={saveRef:{current:advanced},streamRef:{current:[]},inEventRef:{current:true},currentChoicesRef:{current:null},eventContextRef:{current:""},activeEventMetaRef:{current:null},lastFailedActionRef:{current:"处理公事"},loadingPhaseRef:{current:"dm"},completedCompanionsRef:{current:[]},timeTurnIdRef:{current:"turn1"},onSaveUpdate:()=>{}};
persisted.saveGame=value=>persisted.stored=JSON.parse(JSON.stringify(value));
vm.createContext(persisted);
vm.runInContext(ts.transpileModule(`globalThis.persist=${handlers.get("persistSave")};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,persisted);
persisted.persist(advanced);
assert.equal(persisted.stored.pendingEvent.timeTurnId,"turn1");
const reload=envFor(persisted.stored);reload.inEvent=true;
await reload.handlePlayerAction("处理公事",true,true);
assert.equal(reload.saveRef.current.gameTime,"afternoon");
assert.equal(reload.saveRef.current.journal.filter(j=>j.id.endsWith("_time")).length,1);
console.log("PASS retry persistence: actual save callback persists turn ID; actual retry handler after reload does not advance again.");
