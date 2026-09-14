import {WakeStore,startService} from './service.mjs';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const dir=await mkdtemp(`${tmpdir()}/garden-test-`);
try{
 const store=new WakeStore(`${dir}/queue`);await store.load();store.data.config={characterId:'char',serverId:'mcp',mode:'auto',token:'private'};
 await store.enqueue({reason:'new-event',message:'hello'});await store.enqueue({reason:'new-event',message:'hello'});assert.equal(store.data.events.length,1);
 const loaded=new WakeStore(`${dir}/queue`);await loaded.load();assert.equal(loaded.data.events[0].characterId,'char');assert.equal(loaded.data.events[0].message,'hello');
 await assert.rejects(store.enqueue({reason:'bad',message:''}));
 await writeFile(`${dir}/key`,'backend-secret',{mode:0o600});
 const service=await startService({dir:`${dir}/queue`,port:0,secretPath:`${dir}/key`});
 const url=`http://127.0.0.1:${service.server.address().port}`;
 try{
  const call=async(body,auth='Bearer backend-secret')=>fetch(url,{method:'POST',headers:{Authorization:auth},body:JSON.stringify(body)});
  assert.equal((await call({action:'status'},'bad')).status,401);
  const state=await(await call({action:'status'})).json();assert.equal(state.status,'stopped');assert.equal(state.config.hasToken,true);assert.ok(!JSON.stringify(state).includes('private'));
  const events=await(await call({action:'events'})).json();assert.equal(events.events.length,1);
  const firstAck=await(await call({action:'ack',ids:[events.events[0].id]})).json();assert.equal(firstAck.acceptedIds.length,1);
  const duplicateAck=await(await call({action:'ack',ids:[events.events[0].id]})).json();assert.equal(duplicateAck.acceptedIds.length,0);assert.equal((await(await call({action:'events'})).json()).events.length,0);
  await service.store.enqueue({reason:'new-event',message:'hello'});assert.equal(service.store.data.events.length,1);
  assert.equal((await call({action:'save',characterId:'',mode:'auto'})).status,400);
  assert.ok((await readFile(`${dir}/queue/state.json`,'utf8')).includes('hello'));
 }finally{await service.shutdown();}
 console.log('PASS persisted delivery, pending coalescing, consumed event accepted again, private API auth, token redaction, stopped by default');
}finally{await rm(dir,{recursive:true,force:true});}
