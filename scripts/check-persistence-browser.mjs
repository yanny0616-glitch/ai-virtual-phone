// Actual Chromium IndexedDB + installed Dexie. Requires chromium on PATH.
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'out/review-persistence-browser');
await fs.mkdir(out,{recursive:true});
async function moduleCode(file,expose){
    const src=stripTypeScriptTypes(await fs.readFile(path.join(root,file),'utf8')).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g,'');
    return `(()=>{${src}\nreturn {${expose}};})()`;
}
const db=await moduleCode('lib/chat-db.ts','chatDb,dbPutMessageBatch');
const kv=await moduleCode('lib/kv-db.ts','kvDb,registerKvMigration,registerDynamicPrefix,hydrateKvDb,isKvHydrated');
const html=`<!doctype html><meta charset="utf-8"><script src="${pathToFileURL(path.join(root,'node_modules/dexie/dist/dexie.js'))}"></script><script>
const db=${db}, kv=${kv};
(async()=>{
 let checks=0; const check=(v,message)=>{if(!v)throw new Error(message);checks++;};
 const messages=[{id:'m1',sessionId:'s',content:'first'},{id:'m2',sessionId:'s',content:'second'}];
 const sessions=[{id:'s',contactId:'c'}];
 const fail=()=>{throw new Error('injected session write failure');};
 db.chatDb.sessions.hook('creating',fail);
 let rejected=false;try{await db.dbPutMessageBatch(messages,sessions);}catch{rejected=true;}
 check(rejected,'transaction must reject');
 check(await db.chatDb.messages.count()===0,'messages must roll back when session write fails');
 check(await db.chatDb.sessions.count()===0,'session must roll back');
 db.chatDb.sessions.hook('creating').unsubscribe(fail);
 await db.dbPutMessageBatch(messages,sessions);
 check(await db.chatDb.messages.count()===2,'retry persists entire batch');
 check(await db.chatDb.sessions.count()===1,'retry persists session');
 db.chatDb.close();await db.chatDb.open();
 check(await db.chatDb.messages.count()===2,'messages survive database reopen');
 await kv.kvDb.entries.put({key:'fixed',value:'old'});
 localStorage.setItem('fixed','new');localStorage.setItem('prefix:key','new-prefix');
 kv.registerKvMigration('fixed');kv.registerDynamicPrefix('prefix:');
 const failMigration=()=>{throw new Error('injected migration write failure');};
 kv.kvDb.entries.hook('updating',failMigration);
 await kv.hydrateKvDb();
 check(!kv.isKvHydrated(),'failed migration cannot report hydrated');
 check(localStorage.getItem('fixed')==='new'&&localStorage.getItem('prefix:key')==='new-prefix','sources survive migration failure');
 kv.kvDb.entries.hook('updating').unsubscribe(failMigration);
 await kv.hydrateKvDb();
 check(kv.isKvHydrated(),'retry hydrates');
 check((await kv.kvDb.entries.get('fixed')).value==='new','retry writes newer fixed value');
 check((await kv.kvDb.entries.get('prefix:key')).value==='new-prefix','retry writes prefix value');
 check(localStorage.getItem('fixed')===null&&localStorage.getItem('prefix:key')===null,'sources removed only after successful commit');
 window.persistenceCheck={passed:true,checks};
})().catch(e=>{window.persistenceCheck={passed:false,error:String(e),stack:e.stack};});
</script>`;
await fs.writeFile(path.join(out,'index.html'),html);
const profile=await fs.mkdtemp(path.join(out,'profile-'));
const child=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let socket;
try{
 let port;
 for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(!port)throw new Error('Chromium did not start');
 const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
 socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 const pending=new Map();let serial=0;
 socket.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id){const task=pending.get(msg.id);pending.delete(msg.id);if(msg.error)task.reject(new Error(msg.error.message));else task.resolve(msg.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 await send('Page.navigate',{url:pathToFileURL(path.join(out,'index.html')).href});
 let report;
 for(let i=0;i<150;i++){
  const result=await send('Runtime.evaluate',{expression:'JSON.stringify(window.persistenceCheck || null)',returnByValue:true});
  report=JSON.parse(result.result.value||'null');if(report)break;await new Promise(r=>setTimeout(r,100));
 }
 if(!report?.passed)throw new Error(JSON.stringify(report||{error:'browser check timed out'}));
 console.log(`Passed ${report.checks} real IndexedDB persistence assertions.`);
}finally{
 socket?.close();child.kill();
 await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
 await fs.rm(profile,{recursive:true,force:true});
}
