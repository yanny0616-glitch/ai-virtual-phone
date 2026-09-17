// 工坊调用 REST/组合/自定义 APP 工具：授权门禁、指纹失效、定点执行、凭据脱敏
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const read = (file) => fs.readFileSync(new URL('../lib/' + file, import.meta.url), 'utf8');
const js = (s) => stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');

let stored = null;
const rest = [{ id: 'r1', name: '天气', description: '查天气', endpoint: 'https://api.example/weather', method: 'GET', parameterSchema: '{"type":"object","properties":{"city":{"type":"string"}}}', headers: { Authorization: 'Bearer top-secret-key' }, enabled: true }];
const composite = [{ id: 'c1', name: '流程', description: '组合', parameterSchema: '{}', steps: [], enabled: true, updatedAt: 100 }];
const executed = [];
const context = vm.createContext({ console, JSON, Error, String, Object, Map, Array, Boolean,
  kvGet: () => stored, kvSet: (_, v) => { stored = v; },
  loadRestTools: () => rest, loadRestToolPackages: () => [], loadCompositeTools: () => composite, loadCompositeToolPackages: () => [],
  loadCustomAppToolsForContext: () => [{ appId: 'app1', appName: '记账', id: 't1', name: '记一笔', description: '', parameterSchema: { type: 'object' }, visibility: 'shared' }],
  loadInstalledCustomApps: () => [{ id: 'app1', manifest: { version: '1.0.0' } }],
  getQaPageChars: () => 2000,
  executeWorkshopToolboxTool: async (target, args) => { executed.push([target.kind, target.id, args]); return target.kind === 'rest' ? { name: target.name, success: true, data: `晴 (token top-secret-key)` } : { name: target.name, success: false, error: '步骤失败' }; },
});
vm.runInContext(js(read('qa-tool-access.ts')) + ';globalThis.access={loadQaToolAccess,saveQaToolAccess,listQaSelectableTools,getQaAuthorizedTools}', context);
vm.runInContext(js(read('qa-toolbox-call.ts')).replace('await import("./tool-executor")', '({executeWorkshopToolboxTool:globalThis.executeWorkshopToolboxTool})') + ';globalThis.run=runQaToolboxCall;', context);
const { saveQaToolAccess: save, listQaSelectableTools: selectable, getQaAuthorizedTools: authorized } = context.access;
const run = context.run;

// 候选齐全（三类），默认一个都没授权
const all = selectable();
assert.equal(all.length, 3);
assert.equal(all.find((t) => t.kind === 'custom_app').key, 'custom_app:app1:t1');
assert.equal(authorized().length, 0);
assert.equal(JSON.parse(await run({ action: 'list' })).tools.length, 0);
await assert.rejects(run({ action: 'call', tool_key: 'rest:r1' }), /未获/);
assert.equal(executed.length, 0);

// 授权 REST 后可 list/read/call；结果里的密钥被脱敏
const restKey = all.find((t) => t.kind === 'rest');
save({ [restKey.key]: restKey.fingerprint });
assert.equal(authorized().length, 1);
const listing = await run({ action: 'list' });
assert.ok(listing.includes('天气') && !listing.includes('流程') && !listing.includes('top-secret-key'));
assert.equal(JSON.parse(await run({ action: 'read', tool_key: 'rest:r1' })).parameterSchema.properties.city.type, 'string');
const out = await run({ action: 'call', tool_key: 'rest:r1', arguments: { city: '上海' } });
assert.ok(out.includes('晴') && out.includes('[凭据已隐藏]') && !out.includes('top-secret-key'));
assert.deepEqual(executed.at(-1), ['rest', 'r1', { city: '上海' }]);

// REST 换地址 → 指纹变 → 授权失效；改回来恢复
rest[0].endpoint = 'https://evil.example/weather';
await assert.rejects(run({ action: 'call', tool_key: 'rest:r1' }), /未获/);
rest[0].endpoint = 'https://api.example/weather';
// 工具箱关闭 → 不能调
rest[0].enabled = false;
await assert.rejects(run({ action: 'call', tool_key: 'rest:r1' }), /未获/);
rest[0].enabled = true;
// arguments 必须是对象
await assert.rejects(run({ action: 'call', tool_key: 'rest:r1', arguments: '{}' }), /必须是对象/);

// 组合工具：被修改（updatedAt 变）后授权失效；执行失败按错误抛出
const compKey = all.find((t) => t.kind === 'composite');
save({ [compKey.key]: compKey.fingerprint });
await assert.rejects(run({ action: 'call', tool_key: 'composite:c1' }), /步骤失败/);
composite[0].updatedAt = 101;
await assert.rejects(run({ action: 'call', tool_key: 'composite:c1' }), /未获/);

// 自定义 APP 工具：APP 升版后授权失效
const appKey = all.find((t) => t.kind === 'custom_app');
save({ [appKey.key]: appKey.fingerprint });
assert.equal(authorized()[0].kind, 'custom_app');
context.loadInstalledCustomApps = () => [{ id: 'app1', manifest: { version: '1.1.0' } }];
assert.equal(authorized().length, 0);

console.log('PASS workshop toolbox-tool opt-in: REST/composite/custom-app listing, fingerprint invalidation, targeted execution, secret redaction');
