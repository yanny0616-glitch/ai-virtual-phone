import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const code = stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/ai-phone-push/index.ts', import.meta.url), 'utf8'));
for (const conflict of [false,true]) {
  const calls = []; let handler;
  vm.runInNewContext(code, { Date, console, Request, Response, URL, Headers, AbortSignal,
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://test', SUPABASE_SERVICE_ROLE_KEY: 'test' })[key] }, serve: f => handler = f },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.includes('rpc/push_save_recheck_plan')) { calls.push(body); return Response.json(conflict ? { ok:false, conflict:true } : { ok:true, stateVersion:8 }); }
      if (url.includes('rpc/push_retry_scheduler')) { calls.push(body); return Response.json(2); }
      if (url.includes('push_recheck_plans') && init.method === 'POST') throw Error('full upload must go through versioned RPC');
      return Response.json([{ context: {} }]);
    },
  });
  const post = (action, body) => handler(new Request('https://test?action=' + action, { method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify(body) }));
  const response = await post('recheck-plan',{ characterId:'c',planDate:'2026-09-07',stateVersion:7,sessionId:'s',context:{},items:[] });
  assert.equal(response.status, conflict ? 409 : 200); const result = await response.json();
  if (!conflict) assert.equal(result.stateVersion,8); else assert.equal(result.conflict,true);
  assert.equal(calls[0].p_version,7); assert.equal(calls[0].p_row.user_id,'owner');
  const retried = await post('scheduler-retry',{userId:'not-owner',characterId:'c',planDate:'2026-09-07'});
  assert.equal((await retried.json()).resumed,2); assert.equal(calls[1].p_user_id,'owner'); assert.equal(calls[1].p_character_id,'c');
}
console.log('PASS gateway forwards imported versions, surfaces conflicts, returns new versions, and scopes explicit retry to its owner');
