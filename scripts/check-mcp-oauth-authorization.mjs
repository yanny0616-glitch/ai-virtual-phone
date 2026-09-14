import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(fs.readFileSync('lib/tool-executor.ts','utf8'));
const start=source.slice(source.indexOf('export async function startMcpOAuth('),source.indexOf('function waitForAuthCallback(')).replace('export ','');
let probe={headers:{}}, metadataCalls=0, persisted=0, token={access_token:'test-token'}, unavailable=false;
const popup={location:{href:''},close(){}};
const sandbox={URL,URLSearchParams,Date,JSON,Error,String,crypto:{randomUUID:()=> 'state'},
 window:{open:()=>popup,location:{origin:'https://float.example'}},
 renderMcpOAuthPopupLoading(){},mcpRequest:async()=>probe,
 MCP_PROTOCOL_VERSION:'test',MCP_CLIENT_INFO:{},isSseUrl:()=>false,
 resolveMcpOAuthMetadata:async()=>{metadataCalls++;if(unavailable)throw new Error('metadata unavailable');return {metadata:{authorization_endpoint:'https://garden.example/authorize',token_endpoint:'https://garden.example/token',registration_endpoint:'https://garden.example/register'}};},
 proxyFetch:async(url)=>({status:200,text:JSON.stringify(url.endsWith('/register')?{client_id:'registered-client'}:token)}),
 generateCodeVerifier:()=> 'verifier',generateCodeChallenge:async()=> 'challenge',
 writeStorageJson(){},removeStorageKey(){},clearMcpOAuthFlow(){},
 MCP_OAUTH_PENDING_STORAGE_KEY:'pending',MCP_OAUTH_CALLBACK_STORAGE_KEY:'callback',
 waitForAuthCallback:async()=>{assert.match(popup.location.href,/code_challenge=challenge/);return 'code';},
 persistMcpOAuthState(server){assert.equal(server.accessToken,'test-token');persisted++;},
};
vm.createContext(sandbox);vm.runInContext(start+';globalThis.run=startMcpOAuth;',sandbox);
const server=()=>({id:'test',url:'https://garden.example/mcp',enabled:true});
assert.equal((await sandbox.run(server())).success,true);
assert.equal(metadataCalls,1);assert.equal(persisted,1);
probe={headers:{},error:{code:401,message:'Missing bearer token'}};
assert.equal((await sandbox.run(server())).success,true);assert.equal(persisted,2);
probe={headers:{},error:{code:500,message:'unavailable'}};
assert.equal((await sandbox.run(server())).success,false);assert.equal(metadataCalls,2);
probe={headers:{}};unavailable=true;
assert.match((await sandbox.run(server())).error,/metadata unavailable/);
unavailable=false;token={};
assert.match((await sandbox.run(server())).error,/access_token/);assert.equal(persisted,2);
console.log('PASS public initialize requires real OAuth, 401 discovery, transport/metadata failures, missing token rejection');
const resumed=source.slice(source.indexOf('export async function completePendingMcpOAuthCallback('),source.indexOf('// ── MCP Tool Execution')).replace('export ','');
Object.assign(sandbox,{
 MCP_OAUTH_MAX_AGE_MS:600000,
 readStorageJson:key=>key==='pending'?{state:'state',createdAt:Date.now(),serverName:'Garden',tokenEndpoint:'https://garden.example/token'}:{state:'state',code:'code'},
 loadMcpServers:()=>[],saveMcpServers(){throw new Error('must not persist invalid token');},
});
vm.runInContext(resumed+';globalThis.resume=completePendingMcpOAuthCallback;',sandbox);
assert.match((await sandbox.resume()).error,/access_token/);
console.log('PASS mobile OAuth callback rejects empty token before storing authorization');
