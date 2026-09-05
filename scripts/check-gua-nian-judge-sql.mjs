// Lightweight PostgreSQL WASM check; pass an externally installed PGlite module path.
// Example: node scripts/check-gua-nian-judge-sql.mjs /tmp/gua-nian-sql-check/node_modules/@electric-sql/pglite/dist/index.js
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const sql = fs.readFileSync(new URL('../docs/personal-push-supabase.sql', import.meta.url),'utf8');
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(sql.match(/create table if not exists public.push_recheck_plans \([\s\S]*?\n\);/)[0]);
await db.exec(sql.slice(sql.indexOf('-- 独立于设备所有权')));
await db.exec(sql.slice(sql.indexOf('-- 独立于设备所有权'))); // repeat migration is safe
await db.exec(`insert into push_recheck_plans(user_id,character_id,plan_date,context,items) values ('u','c','2026-09-05','{"owner":"device","other":7}','[{"wakeId":"keep"}]');`);
const before=(await db.query('select context,items,updated_at from push_recheck_plans')).rows[0];
const call=async(token,action,chatAt,success=false,cid='c')=>(await db.query('select public.push_recheck_judge($1,$2,$3,$4,$5,$6,$7) as r',['u',cid,'2026-09-05',token,action,chatAt,success])).rows[0].r;
assert.equal((await call('app','claim',1000)).claimed,true);
assert.equal((await call('cloud','claim',1000)).reason,'busy');
assert.equal((await call('cloud','renew',1000)).claimed,false);
assert.equal((await call('cloud','finish',1000,true)).claimed,false);
assert.equal((await call('app','renew',1000)).claimed,true);
assert.equal((await call('app','finish',1000,true)).claimed,true);
assert.equal((await call('cloud','claim',1000)).reason,'handled');
assert.equal((await call('cloud','claim',2000)).claimed,true);
assert.equal((await call('app','finish',1000,true)).claimed,true); // lost response retry must not release new owner
assert.equal((await call('other','claim',2000)).reason,'busy');
assert.equal((await call('cloud','finish',2000,false)).claimed,true);
assert.equal((await call('app','claim',2000)).claimed,true); // unsuccessful call did not consume chat
await db.exec("update push_recheck_plans set judge_until=now()-interval '1 minute'");
assert.equal((await call('cloud','claim',2000)).claimed,true);
assert.equal((await call('app','renew',2000)).claimed,false);
assert.equal((await call('cloud','finish',2000,true)).claimed,true);
assert.equal((await call('app','claim',500)).reason,'handled');
assert.equal((await call('app','claim',1,false,'missing')).reason,'no-plan');
const after=(await db.query('select context,items,updated_at,judged_chat_at from push_recheck_plans')).rows[0];
assert.equal(Number(after.judged_chat_at),2000);
assert.deepEqual({context:after.context,items:after.items,updated_at:after.updated_at},before);
await db.close();
console.log('PostgreSQL judge lease: 19 assertions passed; migration repeat, exclusion, retry, expiry, cursor and unrelated data preservation.');
