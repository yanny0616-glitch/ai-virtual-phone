import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
let event={id:'one',characterId:'char',serverId:'garden',message:'请看通知',reason:'forum',createdAt:new Date().toISOString(),mode:'auto'};
let persisted=false,ack=true,replies=0,writes=0,enabled=true,busy=false;
const sandbox={console,document:{},window:{dispatchEvent(){}},CustomEvent:class{},
 hydrateKvDb:async()=>{},hydrateChatStorage:async()=>{},gardenWakeEnabled:()=>enabled,
 gardenWakeRequest:async b=>b.action==='events'?{events:[event]}:(assert.ok(persisted),{acceptedIds:ack?[event.id]:[]}),
 loadCharacters:()=>[{id:'char'}],loadMcpServers:()=>[{id:'garden',enabled:true,url:'https://galatea.abysslumina.com/mcp'}],
 loadChatContacts:()=>[{characterId:'char'}],addChatContact(){},createOrGetSession:()=>({id:'session'}),
 isBackgroundReplyGenerating:()=>busy,
 upsertImportedChatMessageAsync:async msg=>{assert.equal(msg.role,'user');assert.equal(msg.content,event.message);writes++;persisted=true;},
 CHAT_REQUEST_REPLY_EVENT:'reply',requestBackgroundChatReply:async()=>{replies++;},
};
let src=fs.readFileSync('components/garden-wake-scheduler.tsx','utf8');src=src.slice(src.indexOf('let running='),src.indexOf('export function GardenWakeScheduler'));
vm.createContext(sandbox);vm.runInContext(stripTypeScriptTypes(src).replace('export async','async')+';globalThis.run=receiveGardenWakes',sandbox);
await sandbox.run();assert.equal(replies,1);assert.equal(writes,1);
ack=false;await sandbox.run();assert.equal(replies,1);
ack=true;event={...event,mode:'receive'};await sandbox.run();assert.equal(replies,1);
busy=true;const prev=writes;await sandbox.run();assert.equal(writes,prev);
busy=false;enabled=false;await sandbox.run();assert.equal(writes,prev);
console.log('PASS durable inbound before ack, only ack winner generates, receive-only mode, busy deferral, disabled gate');
const {timingSafeEqual}=await import('node:crypto');
let backendCalls=0;
const apiContext=vm.createContext({Buffer,timingSafeEqual,JSON,Error,AbortSignal,
 isSelfHostedModeEnabled:()=>true,
 readFile:async path=>path.endsWith('client-token')?'owner-key':'backend-key',
 NextResponse:{json:(body,options)=>({body,status:options?.status||200})},
 fetch:async()=>{backendCalls++;return {status:200,json:async()=>({ok:true,status:'stopped'})};},
});
let api=stripTypeScriptTypes(fs.readFileSync('app/api/garden-wake/route.ts','utf8')).replace(/^import .*;$/gm,'').replace(/^export /gm,'');
vm.runInContext(api+';globalThis.post=POST',apiContext);
const req=(key,origin='https://float.example')=>({headers:new Headers({'origin':origin,'sec-fetch-site':'same-origin','host':'float.example',...(key?{'x-float-garden-key':key}:{})}),nextUrl:{origin:'https://float.example'},text:async()=>'{"action":"status"}'});
assert.equal((await apiContext.post(req())).status,401);
assert.equal((await apiContext.post(req('wrong'))).status,401);
assert.equal((await apiContext.post(req('owner-key','https://evil.example'))).status,403);
assert.equal(backendCalls,0);
assert.equal((await apiContext.post(req('owner-key'))).status,200);assert.equal(backendCalls,1);
console.log('PASS private owner key required even with forged same-origin headers; cross-origin requests denied');
