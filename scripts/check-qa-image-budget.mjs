import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const js=s=>stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
let budget=1000000,compactions=0,failCompaction=false,replySize=10,received;
const ctx=vm.createContext({console,AbortController,
 localStorage:{getItem:()=>String(budget)},loadQaGithubConfig:()=>null,QA_TOOLS:[],formatQaErrorMessage:e=>String(e),
 compactQaContext:async()=>{compactions++;if(failCompaction)throw Error('mock failure');return '摘要';},
 callQaAgent:async(_history,options)=>{received=options.context;options.onContext({role:'assistant',content:'r'.repeat(replySize)});},
});
vm.runInContext(js(fs.readFileSync(new URL('../lib/qa-context-budget.ts',import.meta.url),'utf8')),ctx);
vm.runInContext(js(fs.readFileSync(new URL('../lib/qa-chat-store.ts',import.meta.url),'utf8'))+`;
globalThis.test={estimateQaEntryChars,shouldCompactBeforeQaTurn,sendQaMessage,getQaChatSnapshot,
reset(entries){sessions=[{id:'test',title:'test',createdAt:1,updatedAt:1,messages:[],context:entries}];activeSessionId='test';hydrated=true;isGenerating=false;isCompacting=false;emit();}};`,ctx);
const api=ctx.test;
const small='data:image/png;base64,AAAA',large='data:image/png;base64,'+'A'.repeat(4*1024*1024);
assert.equal(api.estimateQaEntryChars({content:'看图',images:[small]}),api.estimateQaEntryChars({content:'看图',images:[large]}));
assert.equal(api.estimateQaEntryChars({content:'abc',files:[{name:'f',content:'text'}]}),8);
api.reset([{role:'user',content:'之前的问题',images:[large]}]);
await api.sendQaMessage('看这三张',[large,large,large]);
assert.equal(compactions,0);assert.equal(received.at(-1).images[0],large);
assert.ok(api.getQaChatSnapshot().contextUsage<0.02);
// Existing over-budget text: compress once before sending, not again after reply.
budget=5000;compactions=0;replySize=6000;api.reset([{role:'user',content:'x'.repeat(6000)}]);
await api.sendQaMessage('继续');assert.equal(compactions,1);
// A failed pre-compaction must not cause an immediate second model call.
failCompaction=true;compactions=0;api.reset([{role:'user',content:'x'.repeat(6000)}]);
await api.sendQaMessage('继续');assert.equal(compactions,1);
// Incoming images alone exceed a deliberately tiny budget: no pointless pre-call.
failCompaction=false;compactions=0;replySize=10;api.reset([{role:'user',content:'之前的问题'}]);
await api.sendQaMessage('看图',[large,large]);assert.equal(compactions,1);assert.equal(received[0].content,'之前的问题');
console.log('PASS actual workshop send flow: base64-independent image estimates, photos preserved, no false compaction, one compression attempt per turn including failure');
