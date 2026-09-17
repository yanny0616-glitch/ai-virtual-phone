import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const read = name => fs.readFileSync(new URL('../lib/'+name, import.meta.url), 'utf8');
const js = source => stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const calls = [];
const context = vm.createContext({ Date, Error, Boolean,
    throwIfAborted: () => {}, normalizeMcpArguments: value => value, mcpInitialize: async () => ({success:true}),
    getMcpSessionHeaders: server => ({Authorization:server.accessToken}), isSseUrl:()=>false,
    mcpRequest: async (...args) => { calls.push(args);return {result:{content:[]}}; },
});
vm.runInContext(js(read('xhs-mcp-tools.ts'))+js(read('xhs-mcp-config.ts'))+';globalThis.reconcile=reconcileXhsMcpServers;',context);
const fresh=context.reconcile([], 'https://float.example');
assert.equal(fresh.length,1);assert.equal(fresh[0].enabled,true);assert.equal(fresh[0].discoveredTools.length,12);
const disabled={...fresh[0],enabled:false};
assert.equal(context.reconcile([disabled], 'https://float.example')[0].enabled,false);
const imported={...fresh[0],id:'imported-existing',accessToken:'test-token',directFetch:false};
const migrated=context.reconcile([imported,{...imported,id:'duplicate'}], 'https://float.example');
assert.equal(migrated.length,1);assert.equal(migrated[0].id,'imported-existing');assert.equal(migrated[0].directFetch,true);
const external={...imported,url:'https://remote.example/mcp',directFetch:false};
assert.equal(context.reconcile([external], 'https://float.example')[0].url,external.url);
const executor=read('tool-executor.ts');
const fn=executor.slice(executor.indexOf('export async function callConfiguredMcpTool('),executor.indexOf('\nasync function executeMcpTool('));
vm.runInContext(js(fn)+';globalThis.call=callConfiguredMcpTool;',context);
await assert.rejects(context.call(disabled,'read_xiaohongshu_note',{}),/关闭/);
assert.equal(calls.length,0);
await context.call(external,'read_xiaohongshu_note',{url:'https://xhslink.cn/o/test'});
assert.equal(calls[0][0],external.url);assert.equal(calls[0][3].Authorization,'test-token');assert.equal(calls[0][7],false);
assert.match(read('xhs-note-client.ts'),/loadMcpServers\(\)\.find\(isXhsMcpServer\)/);
assert.doesNotMatch(read('xhs-note-client.ts'),/fetch\("\/api\/xhs/);
console.log('PASS one toolbox entry, migration/deduplication, disabled gate, configured URL/auth/transport, automatic read uses toolbox');
