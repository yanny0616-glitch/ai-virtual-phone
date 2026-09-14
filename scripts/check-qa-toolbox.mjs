import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(fs.readFileSync(new URL('../lib/qa-toolbox-tools.ts',import.meta.url),'utf8')).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'').replace('await import("./tool-executor")','({discoverMcpTools:globalThis.discoverMcpTools})');
let mcp=[{id:'old',name:'Existing',url:'https://example.com/mcp?token=url-secret',accessToken:'token-secret',refreshToken:'refresh-secret',headers:{Authorization:'header-secret'},enabled:false,createdAt:1,updatedAt:1}],rest=[],composite=[],sequence=0;
const ctx=vm.createContext({URL,Date,console,
 loadMcpServers:()=>structuredClone(mcp),saveMcpServers:rows=>{mcp=structuredClone(rows)},createMcpServer:(name,url)=>({id:'new-'+ ++sequence,name,url,enabled:false,createdAt:1,updatedAt:1}),
 loadRestTools:()=>structuredClone(rest),saveRestTools:rows=>{rest=structuredClone(rows)},createRestTool:name=>({id:'rest-'+ ++sequence,name,enabled:false,method:'GET',endpoint:'',parameterSchema:'{}'}),
 loadCompositeTools:()=>structuredClone(composite),saveCompositeTools:rows=>{composite=structuredClone(rows)},createCompositeTool:name=>({id:'composite-'+ ++sequence,name,enabled:false,steps:[],parameterSchema:'{}'}),
 discoverMcpTools:async(url,server)=>{assert.equal(server.accessToken,'token-secret');return [{name:'play',description:'tool',inputSchema:{type:'object'}}]},
});
vm.runInContext(source+';globalThis.run=manageQaToolbox',ctx);
const run=args=>ctx.run(args), result=async args=>JSON.parse(await run(args));
assert.equal((await result({action:'list'})).items.length,1);
let read=await run({action:'read',id:'old'});
for(const secret of ['url-secret','token-secret','refresh-secret','header-secret'])assert.ok(!read.includes(secret));
assert.equal((await result({action:'save',id:'old',config:{enabled:true,name:'Updated'}})).entry.enabled,true);
assert.equal(mcp[0].accessToken,'token-secret');assert.equal(mcp[0].createdAt,1);
await run({action:'discover',id:'old'});assert.equal(mcp[0].discoveredTools[0].name,'play');assert.equal(mcp[0].enabled,true);
const created=await result({action:'save',config:{name:'Garden',url:'https://example.com/garden'}});
assert.equal(mcp.length,2);assert.equal(created.entry.enabled,false);
await assert.rejects(run({action:'save',id:'absent',config:{enabled:true}}),/不存在/);assert.equal(mcp.length,2);
await assert.rejects(run({action:'save',id:'old',config:{id:'override'}}),/不能修改/);
await assert.rejects(run({action:'save',id:'old',config:{url:'javascript:alert(1)'}}));
await run({action:'save',id:'old',config:{url:'https://new.example/mcp'}});
assert.equal(mcp[0].accessToken,undefined);assert.equal(mcp[0].refreshToken,undefined);assert.equal(mcp[0].headers,undefined);assert.equal(mcp[0].discoveredTools,undefined);
await result({action:'save',kind:'rest',config:{name:'Reader',endpoint:'https://example.com',method:'GET'}});assert.equal(rest.length,1);
await result({action:'save',kind:'composite',config:{name:'Flow',steps:[{id:'step',toolName:'Reader'}]}});assert.equal(composite.length,1);
const registry=fs.readFileSync(new URL('../lib/qa-agent-tools.ts',import.meta.url),'utf8');assert.match(registry,/UNIFIED_BASE_TOOLS:[\s\S]*?QA_TOOLBOX_TOOL/);
console.log('PASS workshop/shared toolbox create/read/patch/enable/discovery, REST/composite config, secret redaction, invalid IDs and destination credential reset');
