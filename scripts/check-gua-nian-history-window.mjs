import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { webcrypto } from "node:crypto";
import { recheckEvidence, updatePromiseThreads } from "../custom-apps/gua-nian/src/domain/promises.mjs";
const read = p => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const strip = p => stripTypeScriptTypes(read(p)).replace(/^import\s[\s\S]*?;\s*$/gm, "").replace(/^export /gm, "");
const ctx = vm.createContext({ Date, Response, console });
vm.runInContext(strip("lib/guanian-cloud-history.ts") + ";globalThis.h={selectGuanianHistory,guanianOnlineRounds,guanianHistoryText,readGuanianCloudHistory,guanianHistoryRounds};", ctx);
const h = ctx.h, base = Date.parse("2026-09-08T02:00:00Z");
const msg = (id, role, n, extra={}) => ({ id, role, content: id, message_at: new Date(base+n*1000).toISOString(), ...extra });
const online = [];
for(let i=0;i<3;i++) online.push(msg("u"+i,"user",i*60), ...Array.from({length:8},(_,j)=>msg("a"+i+"-"+j,"assistant",i*60+j+1,{response_batch_id:"r"+i})));
const summaries = Array.from({length:4},(_,i)=>msg("s"+i,"assistant",i*61+30,{media_type:"offline_summary",content:"用户取消检查，角色仍要求她去。"}));
const all=[...online,...summaries], original=JSON.stringify(all);
let selected=h.selectGuanianHistory(all,{onlineRounds:2,offlineRounds:1});
assert.equal(selected.filter(m=>m.media_type==="offline_summary").length,1);
assert.equal(selected.filter(m=>m.media_type!=="offline_summary").length,18);
assert.equal(h.guanianOnlineRounds(selected).length,2);
selected=h.selectGuanianHistory(all,{onlineRounds:1,offlineRounds:3});
assert.equal(selected.filter(m=>m.media_type==="offline_summary").length,3);
assert.equal(selected.filter(m=>m.media_type!=="offline_summary").length,9);
assert.equal(JSON.stringify(all),original);
assert.match(h.guanianHistoryText({messages:all},480,80,{onlineRounds:1,offlineRounds:1}),/线下摘要（概述双方互动，非角色原话）/);
assert.equal(h.guanianHistoryRounds({messages:summaries},base+3600000),0);
const evidence=recheckEvidence(summaries,[],base-1);
assert.equal(evidence.users.length,0);assert.equal(evidence.updates.length,4);assert.equal(evidence.promiseUpdate,true);
const event={id:"p",kind:"promise",subject:"user",text:"去检查",due:base+86400000,status:"pending",revision:1};
assert.equal(updatePromiseThreads([event],[{id:"p",status:"cancelled",sourceMessageId:"s3"}],base+500000,"cloud",summaries)[0].status,"cancelled");
console.log("PASS separate online/offline windows, bubble grouping, source labels and summary cancellation evidence");

// Read through a full page of bubbles without losing the requested online rounds.
const many=[msg("old-user","user",-1000),msg("old-answer","assistant",-999),msg("new-user","user",0),...Array.from({length:250},(_,i)=>msg("bubble"+i,"assistant",i/10+1,{response_batch_id:"large"}))].reverse();
const queries=[];
const cloud=await h.readGuanianCloudHistory(async path=>{
 queries.push(path);if(path.startsWith("push_outbox"))return Response.json([]);
 if(path.includes("media_type=eq.offline_summary"))return Response.json(summaries.slice(-2));
 const u=new URL("https://test/"+path),offset=Number(u.searchParams.get("offset")||0);
 return Response.json(many.slice(offset,offset+200));
},"owner","session",{onlineRounds:2,offlineRounds:2});
assert.ok(queries.some(p=>p.includes("offset=200")));
assert.equal(h.guanianOnlineRounds(cloud.messages).length,2);
assert.equal(h.selectGuanianHistory(cloud.messages,{onlineRounds:2,offlineRounds:2}).length,255);
assert.ok(queries.every(p=>p.includes("session_id=eq.session")));
console.log("PASS cloud pagination preserves complete rounds and fetches summaries independently");

// Actual offline storage mutations feed the actual mirror queue.
const kv=new Map([["chat_mirror_enabled_v1","1"]]),listeners=new Map();
const window={addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:e=>listeners.get(e.type)?.(e),setTimeout:()=>1,clearTimeout(){},setInterval:()=>1};
const c=vm.createContext({console,Date,crypto:webcrypto,window,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
 kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),kvRemove:k=>kv.delete(k),registerDynamicPrefix(){},registerKvMigration(){},
 loadChatSessions:()=>[{id:"session",contactId:"c"},{id:"group",isGroup:true}],loadChatContacts:()=>[],loadChatMessages:()=>[],isChatStorageHydrated:()=>true,
 CHAT_MESSAGE_PUSHED_EVENT:"push",CHAT_MESSAGE_EDITED_EVENT:"edit",CHAT_MESSAGES_DELETED_EVENT:"delete",CHAT_RESPONSE_BATCH_REPLACED_EVENT:"replace"});
vm.runInContext(strip("lib/chat-offline-storage.ts")+";globalThis.off={saveChatOfflineTurns,clearChatOfflineTurns,loadChatOfflineSummaryEntries};",c);
vm.runInContext(strip("lib/chat-mirror-client.ts")+";globalThis.mirror={installChatMirror,loadQueue,refreshQueuedMessages};",c);
c.mirror.installChatMirror();
const turn={id:"turn",sessionId:"session",userContent:"USER_PRIVATE",assistantContent:"NARRATIVE_PRIVATE",thinkingText:"THINKING_PRIVATE",rawText:"RAW_PRIVATE",summary:"双方已经见面",summaryTag:"custom",createdAt:new Date(base).toISOString()};
c.off.saveChatOfflineTurns("session",[turn]);
assert.equal(c.mirror.loadQueue()[0].content,"双方已经见面");
assert.equal(c.mirror.loadQueue()[0].mediaType,"offline_summary");
assert.doesNotMatch(JSON.stringify(c.mirror.loadQueue()),/PRIVATE/);
c.off.saveChatOfflineTurns("session",[{...turn,summary:"用户明确取消检查"}]);
assert.equal(c.mirror.loadQueue().length,1);assert.equal(c.mirror.loadQueue()[0].content,"用户明确取消检查");
c.mirror.refreshQueuedMessages();assert.ok(!c.mirror.loadQueue()[0].deleted);
c.off.clearChatOfflineTurns("session");assert.equal(c.mirror.loadQueue()[0].deleted,true);
c.off.saveChatOfflineTurns("group",[{...turn,sessionId:"group"}]);assert.equal(c.mirror.loadQueue().length,1);
console.log("PASS stored summaries only; edits replace, deletes propagate, group isolation");

// Execute the SDK handler itself, preserving its legacy limit path.
const host=read("lib/custom-app-host-api.ts");const start=host.indexOf("export function readCustomAppChatHistory(");const end=host.indexOf("export async function requestCustomAppReply",start);
const hc=vm.createContext({findReadableSession:()=>({id:"session",contactId:"c"}),cleanText:v=>String(v||""),
 loadChatMessages:()=>online.map(m=>({...m,sessionId:"session",createdAt:m.message_at,responseBatchId:m.response_batch_id})),
 loadChatOfflineSummaryEntries:()=>summaries.map(m=>({...m,createdAt:m.message_at})),selectGuanianHistory:h.selectGuanianHistory,serializeChatMessage:m=>m});
vm.runInContext(stripTypeScriptTypes(host.slice(start,end)).replace(/^export /gm,"")+";globalThis.read=readCustomAppChatHistory;",hc);
const result=hc.read({onlineRounds:1,offlineRounds:2});assert.equal(result.historyMode,"separate-rounds-v1");assert.equal(result.messages.length,11);
assert.equal(result.messages.filter(m=>m.mediaType==="offline_summary").length,2);
assert.equal(hc.read({limit:3}).messages.length,3);
console.log("PASS actual SDK independent windows and unchanged legacy message limit");

// Generated app migrates settings independently and consumes the SDK source marker.
let settings={id:'settings',judgeLines:60,deviceId:'test',characterIds:['c']};
const pc=vm.createContext({console,Date,URLSearchParams,AiPhone:{db:{list:async()=>[settings],update:async(_table,_id,patch)=>(settings={...settings,...patch})},chat:{readHistory:async input=>hc.read(input)}}});
const bundled=read('custom-apps/gua-nian/index.html').match(/<script>([\s\S]*)<\/script>/)[1];
vm.runInContext(bundled.replace(/  init\(\);\s*\}\)\(\);\s*$/,'globalThis.app={S,loadSettings,readRecentChat,chatExcerpt,SET_FIELDS};\n})();'),pc);
await pc.app.loadSettings();
assert.equal(pc.app.S.settings.onlineRounds,60);assert.equal(pc.app.S.settings.offlineRounds,40);
const fields=pc.app.SET_FIELDS();assert.ok(fields.some(f=>f.key==='onlineRounds'));assert.ok(fields.some(f=>f.key==='offlineRounds'));
const recent=await pc.app.readRecentChat({character:{id:'c'}});
assert.equal(recent.filter(m=>m.media_type==='offline_summary').length,4);
assert.match(pc.app.chatExcerpt(recent).join('\n'),/线下摘要/);
console.log('PASS generated app separate settings migration and summary ingestion');

// The actual generation worker also sees summary-only context and honors abandonment.
const { fixture } = await import('./lib/gua-nian-worker-fixture.mjs');
const worker = fixture();await worker.init();
worker.h.plan.context.day.schedule=[];
worker.h.plan.context.onlineRounds=1;worker.h.plan.context.offlineRounds=1;
worker.h.mirrors=[{id:'offline-summary:latest',role:'assistant',media_type:'offline_summary',content:'用户明确取消检查，未同意重新安排。',message_at:new Date(worker.h.now-1000).toISOString()}];
worker.h.answer='[挂念作罢：事情已解决或发生变化]';
await worker.run();
assert.equal(worker.h.calls.length,1);
assert.match(JSON.stringify(worker.h.calls[0]),/线下摘要（概述双方互动，非角色原话）/);
assert.equal(worker.h.outbox.length,0);
console.log('PASS actual generation worker uses separate summary window and honors abandonment');
