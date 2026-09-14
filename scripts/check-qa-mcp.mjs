import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const read=file=>fs.readFileSync(new URL('../lib/'+file,import.meta.url),'utf8');
const js=s=>stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
let stored=null,calls=0,response={content:[{type:'text',text:'真实结果'}]};
const servers=[{id:'a',name:'Garden',enabled:true,url:'https://garden.example/mcp',accessToken:'private-token',discoveredTools:[{name:'read',description:'read',inputSchema:{type:'object'}}]},{id:'b',name:'Other',enabled:true,url:'https://other.example/mcp',discoveredTools:[]}];
const context=vm.createContext({console,JSON,Error,
 kvGet:()=>stored,kvSet:(_,value)=>stored=value,loadMcpServers:()=>servers,
 getQaPageChars:()=>2000,
 callConfiguredMcpTool:async(server,name,args)=>{calls++;assert.equal(server.accessToken,'private-token');assert.equal(name,'read');assert.equal(args.page,1);return response;},
});
vm.runInContext(js(read('qa-mcp-access.ts'))+';globalThis.access={loadQaMcpAccess,saveQaMcpAccess,getQaMcpServers}',context);
vm.runInContext(js(read('qa-mcp-tools.ts')).replace('await import("./tool-executor")','({callConfiguredMcpTool:globalThis.callConfiguredMcpTool})')+';globalThis.run=runQaMcp;',context);
const {saveQaMcpAccess:save,getQaMcpServers:allowed}=context.access,run=context.run;
assert.equal(allowed().length,0);
await assert.rejects(run({action:'call',server_id:'a',tool_name:'read'}),/未获/);assert.equal(calls,0);
save({a:servers[0].url});assert.equal(allowed().length,1);
const listing=await run({action:'list'});assert.ok(listing.includes('Garden'));assert.ok(!listing.includes('Other'));assert.ok(!listing.includes('private-token'));
assert.equal(JSON.parse(await run({action:'read',server_id:'a',tool_name:'read'})).inputSchema.type,'object');
const args={action:'call',server_id:'a',tool_name:'read',arguments:{page:1}};
assert.equal(await run(args),'真实结果');assert.equal(calls,1);
response={isError:true,content:[{type:'text',text:'拒绝 private-token'}]};
await assert.rejects(run(args),err=>err.message.includes('凭据已隐藏')&&!err.message.includes('private-token'));
response={content:[{type:'image',data:'huge-base64'},{type:'text',text:'正文'}]};
assert.match(await run(args),/不能据此声称/);
servers[0].enabled=false;await assert.rejects(run(args),/未获/);
servers[0].enabled=true;servers[0].url='https://new.example/mcp';await assert.rejects(run(args),/未获/);
servers[0].url='https://garden.example/mcp';save({});await assert.rejects(run(args),/未获/);
save({a:servers[0].url});await assert.rejects(run({...args,arguments:'{}'}),/必须是对象/);
console.log('PASS workshop MCP opt-in, shared transport, schema reading, denied unselected/disabled/changed URLs, real failures and credential redaction');
