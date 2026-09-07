import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();
const sql=fs.readFileSync(new URL('../docs/personal-push-supabase.sql',import.meta.url),'utf8');
await db.exec('create role anon; create role authenticated; create role service_role;');
for(const name of ['push_recheck_plans','push_chat_mirror','push_outbox','push_jobs']) await db.exec(sql.match(new RegExp(`create table if not exists public.${name} \\([\\s\\S]*?\\n\\);`))[0]);
await db.exec(sql.match(/create unique index if not exists push_jobs_trigger_idx[^;]*;/)[0]);
const schema=sql.slice(sql.indexOf('-- BEGIN GUANIAN EVENTS SCHEMA 11'),sql.indexOf('-- END GUANIAN EVENTS SCHEMA 11'));
await db.exec(schema);await db.exec(schema);
const lease=async(token,action,sid='s')=>(await db.query('select public.push_generation_lease($1,$2,$3,$4) r',['u',sid,token,action])).rows[0].r;
assert.equal(await lease('a','claim'),true);assert.equal(await lease('b','claim'),false);assert.equal(await lease('b','renew'),false);assert.equal(await lease('b','release'),true);assert.equal(await lease('b','claim'),false);assert.equal(await lease('a','renew'),true);assert.equal(await lease('a','release'),true);assert.equal(await lease('b','claim'),true);assert.equal(await lease('c','claim','other'),true);
await db.query("update push_generation_locks set expires_at=now()-interval '1 minute' where session_id='s'");
assert.equal(await lease('b','renew'),false);assert.equal(await lease('new','claim'),true);assert.equal(await lease('b','renew'),false);
console.log('PASS schema11 可重复执行；同会话互斥、续租和所有权释放；不同会话独立');
const thread={id:'p1',kind:'promise',text:'回家',subject:'character',revision:1,due:Date.parse('2026-09-07T15:30Z'),done:false};
await db.query('insert into push_recheck_plans(user_id,character_id,plan_date,context,items) values ($1,$2,$3,$4,$5)',['u','c','2026-09-07',JSON.stringify({unrelated:42,threads:[thread]}),'[]']);
const arm=async(revision=1)=>{const item={from:'p1',kind:'promise',promiseRevision:revision,act:true,wakeId:'w'+revision,fireAt:thread.due,source:'约定·回家',time:'15:30'};return(await db.query('select public.push_arm_promise($1,$2,$3,$4,$5,$6,$7) r',['u','c','2026-09-07','p1',revision,JSON.stringify(item),JSON.stringify({v:1,ct:'encrypted-test'})])).rows[0].r;};
assert.equal(await arm(),true);assert.equal(await arm(),true);assert.equal((await db.query('select * from push_jobs')).rows.length,1);
let p=(await db.query('select * from push_recheck_plans')).rows[0];assert.equal(p.items.length,1);assert.equal(p.context.unrelated,42);assert.equal(p.items[0].kind,'promise');
await db.query("update push_recheck_plans set context=jsonb_set(context,'{threads,0,revision}','2')");assert.equal(await arm(1),false);assert.equal(await arm(2),true);
const jobs=(await db.query('select * from push_jobs order by trigger_key')).rows;assert.equal(jobs[0].status,'cancelled');assert.equal(jobs[1].status,'pending');
p=(await db.query('select * from push_recheck_plans')).rows[0];assert.equal(p.items.filter(x=>x.act).length,1);assert.equal(p.context.unrelated,42);
await db.query("update push_recheck_plans set context=jsonb_set(context,'{threads,0,done}','true')");assert.equal(await arm(2),false);
assert.equal((await db.query('select public.push_cancel_stale_promises($1,$2,$3) r',['u','c',JSON.stringify([{...thread,done:true,revision:2}])])).rows[0].r,0);
assert.equal((await db.query("select status from push_jobs where trigger_key='timedwake:w2'")).rows[0].status,'cancelled');
// A stale full upload cannot revive revision 1, drop revision 2's item, or undo completion.
await db.query('update push_recheck_plans set context=$1,items=$2 where character_id=$3 and plan_date=$4', [JSON.stringify({threads:[{...thread,at:9999999999999}]}),'[]','c','2026-09-07']);
p=(await db.query("select * from push_recheck_plans where character_id='c'")).rows[0];
assert.equal(p.context.threads[0].revision,2);assert.equal(p.context.threads[0].done,true);assert.equal(p.items.length,2);
assert.equal(p.items.filter(w=>w.act).length,0);
assert.equal((await db.query('select push_promise_storage_ready() ready')).rows[0].ready,true);
// Tomorrow's stale snapshot must inherit the latest revision from the existing day.
await db.query('insert into push_recheck_plans(user_id,character_id,plan_date,context,items) values ($1,$2,$3,$4,$5)', ['u','c','2026-09-08',JSON.stringify({threads:[thread]}),'[]']);
p=(await db.query("select * from push_recheck_plans where character_id='c' and plan_date='2026-09-08'")).rows[0];
assert.equal(p.context.threads[0].revision,2);assert.equal(p.context.threads[0].done,true);
// A pending event crosses daily plans with one job, even when the caller supplies another ID.
await db.query('insert into push_recheck_plans(user_id,character_id,plan_date,context,items) values ($1,$2,$3,$4,$5)', ['u','d','2026-09-07',JSON.stringify({threads:[thread]}),'[]']);
const armDay=async(date,wakeId)=>(await db.query('select push_arm_promise($1,$2,$3,$4,$5,$6,$7) r',['u','d',date,'p1',1,JSON.stringify({kind:'promise',from:'p1',promiseRevision:1,wakeId,act:true,time:'15:30',fireAt:thread.due}),JSON.stringify({v:1,ct:'test'})])).rows[0].r;
assert.equal(await armDay('2026-09-07','legacy-local'),true);
await db.query('insert into push_recheck_plans(user_id,character_id,plan_date,context,items) values ($1,$2,$3,$4,$5)', ['u','d','2026-09-08',JSON.stringify({threads:[thread]}),'[]']);
assert.equal(await armDay('2026-09-08','new-cloud'),true);
assert.equal((await db.query("select * from push_jobs where trigger_key='timedwake:new-cloud'")).rows.length,0);
assert.equal((await db.query("select items from push_recheck_plans where character_id='d' and plan_date='2026-09-08'")).rows[0].items[0].wakeId,'legacy-local');
// Clear-plan/reset retains the durable promise item and ordinary items remain replaceable.
await db.query("update push_recheck_plans set items='[]', decisions='[]' where character_id='d' and plan_date='2026-09-08'");
assert.equal((await db.query("select items from push_recheck_plans where character_id='d' and plan_date='2026-09-08'")).rows[0].items[0].wakeId,'legacy-local');
// A failed cancellation rolls back the ledger change in the same transaction.
await db.exec("create function test_cancel_failure() returns trigger language plpgsql as $$ begin raise exception 'cancel unavailable'; end $$; create trigger test_cancel_failure before update on push_jobs for each row execute function test_cancel_failure();");
await assert.rejects(db.query("update push_recheck_plans set context=jsonb_set(context,'{threads,0,revision}','2') where character_id='d' and plan_date='2026-09-08'"),/cancel unavailable/);
assert.equal((await db.query("select context from push_recheck_plans where character_id='d' and plan_date='2026-09-08'")).rows[0].context.threads[0].revision,1);
assert.equal((await db.query("select status from push_jobs where trigger_key='timedwake:legacy-local'")).rows[0].status,'pending');
await db.exec('drop trigger test_cancel_failure on push_jobs; drop function test_cancel_failure();');
console.log('PASS 原子撤旧；旧上传不能回退版本/复活完成事件；跨天继承；同事件跨天只保留一个 job；重排保留约定');
await db.exec('set role anon;');await assert.rejects(lease('bad','claim'),/permission denied/);await assert.rejects(arm(),/permission denied/);await db.exec('reset role;');
console.log('PASS 约定入库与挂任务原子提交；重复不加任务；改期撤旧；完成不再挂；匿名调用被拒绝');
await db.close();
