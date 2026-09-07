-- ai-phone-personal-push-schema-v1
-- 由小手机一键部署到用户自己的 Supabase；__PROJECT_REF__ 会在部署时替换。

-- 硬保险：只允许空项目、旧版个人云项目或已由本应用标记的专用项目。
-- 不依赖作者站点的某张业务表，因此自部署站点也能得到同样保护。
do $$
declare
  has_marker boolean := to_regclass('public.ai_phone_cloud_meta') is not null;
  has_unknown_public_table boolean;
begin
  select exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname <> all (array[
        'ai_phone_cloud_meta',
        'push_server_config', 'push_subscriptions', 'push_jobs', 'push_outbox',
        'push_shortcut_commands', 'push_bridge_config', 'push_bridge_snapshots',
        'push_screen_sessions', 'push_screen_threads', 'push_chat_mirror',
        'push_recheck_plans', 'push_api_usage', 'push_api_limits', 'push_generation_locks'
      ])
  ) into has_unknown_public_table;

  if not has_marker and has_unknown_public_table then
    raise exception 'AI_PHONE_GUARD: 目标项目已包含其他业务表，拒绝部署个人云服务，请使用新建的专用项目';
  end if;
end $$;

create table if not exists public.ai_phone_cloud_meta (
  id text primary key,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.ai_phone_cloud_meta (id, schema_version, updated_at)
values ('personal-cloud', 12, now())
on conflict (id) do update set schema_version = excluded.schema_version, updated_at = excluded.updated_at;

create table if not exists public.push_server_config (
  id text primary key,
  vapid_public_key text not null,
  vapid_private_key text not null,
  cron_secret text,
  payload_key text,
  site_origin text,
  created_at timestamptz not null default now()
);
alter table public.push_server_config add column if not exists cron_secret text;
alter table public.push_server_config add column if not exists payload_key text;
alter table public.push_server_config add column if not exists site_origin text;

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  fail_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.push_jobs (
  id text primary key,
  user_id text not null,
  trigger_key text not null,
  kind text not null,
  execute_at timestamptz not null,
  status text not null default 'pending',
  payload jsonb not null,
  result_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_jobs_status_check check (status in ('pending', 'running', 'done', 'cancelled', 'failed'))
);
alter table public.push_jobs drop constraint if exists push_jobs_kind_check;
alter table public.push_jobs add constraint push_jobs_kind_check
  check (kind in ('followup', 'reply_bailout', 'timed_task', 'bridge_scan', 'shortcut_resume', 'template'));
create unique index if not exists push_jobs_trigger_idx on public.push_jobs (user_id, trigger_key);
create index if not exists push_jobs_due_idx on public.push_jobs (status, execute_at);

create table if not exists public.push_outbox (
  id text primary key,
  user_id text not null,
  job_id text,
  session_id text,
  trigger_key text,
  raw_text text not null,
  meta jsonb,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index if not exists push_outbox_user_idx
  on public.push_outbox (user_id, consumed_at, created_at);

-- push-generate 的普通离线任务不会访问快捷指令表；保留兼容表，避免未来升级时重建数据库。
create table if not exists public.push_shortcut_commands (
  id text primary key,
  user_id text not null,
  action_id text not null,
  action_name text not null,
  shortcut_name text not null,
  delivery_mode text not null default 'push',
  callback_token text not null,
  action_args jsonb not null default '{}'::jsonb,
  result_mode text not null default 'none',
  status text not null default 'pending',
  result jsonb,
  error text,
  expires_at timestamptz not null,
  notified_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 快捷指令图片结果只在第二轮生成期间临时保存。桶保持私有，Edge Function
-- 使用 service_role 上传/读取/删除；不向 anon 或 authenticated 开放策略。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shortcut-command-media',
  'shortcut-command-media',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 现实桥离线联动：规则/云配置/触发状态 + 每条规则的 prompt 快照。
-- bridge_token 供 iPhone 快捷指令免登录唤醒扫描（网关 bridge-wake 动作）。
create table if not exists public.push_bridge_config (
  user_id text primary key,
  bridge_token text not null,
  rules jsonb not null default '[]'::jsonb,
  cloud_config jsonb,
  rule_runs jsonb not null default '{}'::jsonb,
  daily_cap integer not null default 20,
  daily_count jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_bridge_config_token_idx on public.push_bridge_config (bridge_token);
-- 离线快捷动作目录：角色离线回复输出【快捷动作：名称】时按它匹配执行
alter table public.push_bridge_config add column if not exists shortcut_actions jsonb not null default '[]'::jsonb;
-- 站点的桥令牌（明文，非密钥）。邮件模式的快捷动作个人云自己发不了信（没有
-- RESEND_API_KEY），要把「代发那封信」外包给站点，凭这个令牌认账号。
alter table public.push_bridge_config add column if not exists site_bridge_token text;

create table if not exists public.push_bridge_snapshots (
  user_id text not null,
  rule_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, rule_id)
);

-- v2 的 push_screen_sessions 是按时间切分的第二套聊天记录，还会持久化原始截图。
-- 屏幕速聊现在只是小手机唯一聊天窗口的远程入口，因此升级时移除这份临时缓存。
drop table if exists public.push_screen_sessions;

create table if not exists public.push_screen_threads (
  user_id text not null,
  character_id text not null,
  session_id text not null,
  pending_turns jsonb not null default '[]'::jsonb,
  next_sequence integer not null default 0,
  lock_token text,
  lock_expires_at timestamptz,
  usage_day date not null default ((now() at time zone 'utc')::date),
  usage_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id),
  constraint push_screen_threads_pending_array check (jsonb_typeof(pending_turns) = 'array')
);

-- 聊天镜像：客户端把新消息抄送到用户自己的项目（追加为主，按 id 幂等）。
-- 供云端离线判断（未回应降速、动态复核）与挂念面板读取；60 天自动清理。
create table if not exists public.push_chat_mirror (
  id text primary key,
  user_id text not null,
  session_id text not null default '',
  character_id text not null default '',
  role text not null,
  content text not null default '',
  media_type text,
  message_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint push_chat_mirror_role_check check (role in ('user', 'assistant'))
);
create index if not exists push_chat_mirror_char_idx
  on public.push_chat_mirror (user_id, character_id, message_at desc);

-- 模型调用用量账本：按「用户 / 本地日期 / 来源」累加次数与 token。来源：app（小手机本机，由 App 上报）、
-- cloud-recheck / cloud-gen / cloud-wake（云函数自己记）。挂念的用量页和「一天最多调多少次」都看这张表。
create table if not exists public.push_api_usage (
  user_id text not null,
  day text not null,
  source text not null,
  calls integer not null default 0,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day, source)
);
-- 上限与时区：App 保存设置时写；云函数调模型前先看今天合计有没有超。tz 是本地时区偏移（分钟），
-- 云端只有 UTC，「今天」得靠它换算。
create table if not exists public.push_api_limits (
  user_id text primary key,
  daily_calls integer not null default 0,
  daily_tokens bigint not null default 0,
  tz integer not null default 0,
  updated_at timestamptz not null default now()
);
-- 原子累加：几个云函数可能同时记账，读改写会互相覆盖。
create or replace function public.ai_phone_usage_add(
  p_user_id text, p_day text, p_source text, p_calls integer, p_prompt bigint, p_completion bigint
) returns void
language sql
security invoker
as $$
  insert into public.push_api_usage (user_id, day, source, calls, prompt_tokens, completion_tokens, updated_at)
  values (p_user_id, p_day, p_source, p_calls, p_prompt, p_completion, now())
  on conflict (user_id, day, source) do update
    set calls = public.push_api_usage.calls + excluded.calls,
        prompt_tokens = public.push_api_usage.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = public.push_api_usage.completion_tokens + excluded.completion_tokens,
        updated_at = now();
$$;

-- 云端动态复核：App 编排时把当天计划和判断上下文传上来，浏览器关着时由
-- push-recheck 定时重判。items 里的 wakeId 对应 push_jobs 的 timedwake:<wakeId>，撤销/点亮直接改那边；
-- decisions 是还没被 App 取走的云端裁决，App 下次打开时合并进本地轨迹。
create table if not exists public.push_recheck_plans (
  user_id text not null,
  character_id text not null,
  plan_date text not null,
  session_id text not null default '',
  context jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  decisions jsonb not null default '[]'::jsonb,
  last_recheck_at timestamptz,
  recheck_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id, plan_date),
  constraint push_recheck_plans_items_array check (jsonb_typeof(items) = 'array'),
  constraint push_recheck_plans_decisions_array check (jsonb_typeof(decisions) = 'array')
);
-- BEGIN SCHEDULER STATE SCHEMA 12
alter table public.push_recheck_plans add column if not exists state_version bigint not null default 1;
alter table public.push_recheck_plans add column if not exists retry_count integer not null default 0;
alter table public.push_recheck_plans add column if not exists next_retry_at timestamptz;
alter table public.push_recheck_plans add column if not exists retry_error text;
alter table public.push_recheck_plans add column if not exists retry_stopped boolean not null default false;
create or replace function public.push_plan_version() returns trigger language plpgsql as $$
begin
 if tg_op='INSERT' then new.state_version:=1;
 elsif new.context is distinct from old.context or new.items is distinct from old.items
  or (new.decisions is distinct from old.decisions and coalesce(current_setting('float.ack_decisions',true),'')<>'1') then
  new.state_version:=old.state_version+1;
 else new.state_version:=old.state_version;
 end if;
 return new;
end $$;
drop trigger if exists zz_push_plan_version on public.push_recheck_plans;
create trigger zz_push_plan_version before insert or update on public.push_recheck_plans
for each row execute function public.push_plan_version();

-- Full uploads require the version the app actually imported. Insert races are safe too.
create or replace function public.push_save_recheck_plan(p_row jsonb, p_version bigint)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.push_recheck_plans; saved public.push_recheck_plans;
begin
 perform pg_advisory_xact_lock(hashtextextended((p_row->>'user_id')||':'||(p_row->>'character_id')||':'||(p_row->>'plan_date'),0));
 select * into r from push_recheck_plans where user_id=p_row->>'user_id' and character_id=p_row->>'character_id' and plan_date=p_row->>'plan_date' for update;
 if (found and (p_version is null or p_version<>r.state_version)) or (not found and coalesce(p_version,0)<>0) then
  return jsonb_build_object('ok',false,'conflict',true);
 end if;
 insert into push_recheck_plans(user_id,character_id,plan_date,session_id,context,items,decisions,recheck_count,updated_at)
 values(p_row->>'user_id',p_row->>'character_id',p_row->>'plan_date',coalesce(p_row->>'session_id',''),p_row->'context',p_row->'items',coalesce(p_row->'decisions',r.decisions,'[]'),coalesce((p_row->>'recheck_count')::integer,r.recheck_count,0),now())
 on conflict(user_id,character_id,plan_date) do update set session_id=excluded.session_id,context=excluded.context,items=excluded.items,
 decisions=excluded.decisions,recheck_count=excluded.recheck_count,updated_at=excluded.updated_at,
 retry_count=0,next_retry_at=null,retry_error=null,retry_stopped=false,
 last_recheck_at=case when push_recheck_plans.last_recheck_at>now() then null else push_recheck_plans.last_recheck_at end
 returning * into saved;
 return jsonb_build_object('ok',true,'stateVersion',saved.state_version);
end $$;
revoke all on function public.push_save_recheck_plan(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.push_save_recheck_plan(jsonb,bigint) to service_role;

create or replace function public.push_retry_scheduler(p_user_id text, p_character_id text, p_date text)
returns integer language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
 update push_jobs set status='pending',execute_at=now(),result_note='retry resumed',updated_at=now()
 where user_id=p_user_id and status='failed' and result_note like '[retry:%] stopped:%'
 and trigger_key in (select 'timedwake:'||(w->>'wakeId') from push_recheck_plans p,
 jsonb_array_elements(p.items) w where p.user_id=p_user_id and p.character_id=p_character_id and p.plan_date=p_date);
 get diagnostics n=row_count;
 update push_recheck_plans set retry_count=0,next_retry_at=null,retry_error=null,retry_stopped=false,last_recheck_at=null
 where user_id=p_user_id and character_id=p_character_id and plan_date=p_date;
 return n;
end $$;
revoke all on function public.push_retry_scheduler(text,text,text) from public,anon,authenticated;
grant execute on function public.push_retry_scheduler(text,text,text) to service_role;
-- Cancel superseded ordinary wakes only after the version-checked plan write succeeds.
create or replace function public.push_cancel_changed_slots() returns trigger language plpgsql set search_path=public as $$
begin
 update push_jobs j set status='cancelled',result_note='plan slot replaced',updated_at=now()
 where j.user_id=new.user_id and j.status='pending' and exists (
  select 1 from jsonb_array_elements(old.items) w where coalesce(w->>'kind','')<>'promise' and w->>'act'='true'
  and j.trigger_key='timedwake:'||(w->>'wakeId') and not exists (
   select 1 from jsonb_array_elements(new.items) n where n->>'wakeId'=w->>'wakeId' and n->>'act'='true'));
 return new;
end $$;
drop trigger if exists push_cancel_changed_slots on public.push_recheck_plans;
create trigger push_cancel_changed_slots after update of items on public.push_recheck_plans
for each row execute function public.push_cancel_changed_slots();
create or replace function public.push_append_recheck_decision(p_user_id text,p_character_id text,p_date text,p_entry jsonb)
returns void language sql security invoker set search_path=public as $$
 update push_recheck_plans set decisions=(select coalesce(jsonb_agg(e order by ord),'[]') from
  (select e,ord from jsonb_array_elements(decisions||jsonb_build_array(p_entry)) with ordinality a(e,ord) order by ord desc limit 60) a)
 where user_id=p_user_id and character_id=p_character_id and plan_date=p_date;
$$;
revoke all on function public.push_append_recheck_decision(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.push_append_recheck_decision(text,text,text,jsonb) to service_role;
create or replace function public.push_scheduler_storage_ready() returns boolean language sql security invoker set search_path=public as $$
 select exists(select 1 from pg_trigger where tgrelid='public.push_recheck_plans'::regclass and tgname='zz_push_plan_version' and tgenabled<>'D')
 and exists(select 1 from pg_trigger where tgrelid='public.push_recheck_plans'::regclass and tgname='push_cancel_changed_slots' and tgenabled<>'D')
 and to_regprocedure('public.push_save_recheck_plan(jsonb,bigint)') is not null
 and to_regprocedure('public.push_retry_scheduler(text,text,text)') is not null
 and to_regprocedure('public.push_append_recheck_decision(text,text,text,jsonb)') is not null;
$$;
revoke all on function public.push_scheduler_storage_ready() from public,anon,authenticated;
grant execute on function public.push_scheduler_storage_ready() to service_role;
-- END SCHEDULER STATE SCHEMA 12

-- cron 每轮的取数就是「按 last_recheck_at 最旧的几条、且 App 近期传过」，索引照这个顺序建。
create index if not exists push_recheck_plans_due_idx
  on public.push_recheck_plans (last_recheck_at nulls first, updated_at);

-- 原子取得每个角色的生成锁并扣减日额度。不同悬浮球请求不会同时覆盖上下文。
create or replace function public.ai_phone_screen_chat_begin(
  p_user_id text,
  p_character_id text,
  p_session_id text,
  p_lock_token text,
  p_daily_cap integer
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_pending jsonb;
  v_sequence integer;
  v_session text;
  v_today date := (now() at time zone 'utc')::date;
begin
  insert into public.push_screen_threads (user_id, character_id, session_id)
  values (p_user_id, p_character_id, p_session_id)
  on conflict (user_id, character_id) do nothing;

  update public.push_screen_threads
     set pending_turns = case when session_id = p_session_id then pending_turns else '[]'::jsonb end,
         next_sequence = case when session_id = p_session_id then next_sequence else 0 end,
         session_id = p_session_id,
         lock_token = p_lock_token,
         lock_expires_at = now() + interval '130 seconds',
         usage_count = case when usage_day = v_today then usage_count + 1 else 1 end,
         usage_day = v_today,
         updated_at = now()
   where user_id = p_user_id
     and character_id = p_character_id
     and (lock_token is null or lock_expires_at is null or lock_expires_at <= now())
     and (usage_day <> v_today or usage_count < greatest(1, least(p_daily_cap, 500)))
  returning pending_turns, next_sequence, session_id
       into v_pending, v_sequence, v_session;

  if found then
    return jsonb_build_object(
      'status', 'ok',
      'pendingTurns', v_pending,
      'nextSequence', v_sequence,
      'sessionId', v_session
    );
  end if;

  if exists (
    select 1 from public.push_screen_threads
     where user_id = p_user_id and character_id = p_character_id
       and lock_token is not null and lock_expires_at > now()
  ) then
    return jsonb_build_object('status', 'busy');
  end if;
  return jsonb_build_object('status', 'daily_cap');
end;
$function$;

-- 上下文水位与回传箱在同一事务提交；任何一步失败，本轮都不会伪装成成功。
create or replace function public.ai_phone_screen_chat_finish(
  p_user_id text,
  p_character_id text,
  p_lock_token text,
  p_pending_turns jsonb,
  p_next_sequence integer,
  p_outbox_id text,
  p_session_id text,
  p_trigger_key text,
  p_raw_text text,
  p_meta jsonb
) returns boolean
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if jsonb_typeof(p_pending_turns) <> 'array' then return false; end if;
  update public.push_screen_threads
     set pending_turns = p_pending_turns,
         next_sequence = greatest(next_sequence, p_next_sequence),
         lock_token = null,
         lock_expires_at = null,
         updated_at = now()
   where user_id = p_user_id and character_id = p_character_id and lock_token = p_lock_token;
  if not found then return false; end if;

  insert into public.push_outbox (
    id, user_id, job_id, session_id, trigger_key, raw_text, meta
  ) values (
    p_outbox_id, p_user_id, null, p_session_id, p_trigger_key, p_raw_text, p_meta
  ) on conflict (id) do nothing;
  return true;
end;
$function$;

create or replace function public.ai_phone_screen_chat_abort(
  p_user_id text,
  p_character_id text,
  p_lock_token text
) returns boolean
language sql
security invoker
set search_path = public
as $function$
  update public.push_screen_threads
     set lock_token = null, lock_expires_at = null, updated_at = now()
   where user_id = p_user_id and character_id = p_character_id and lock_token = p_lock_token
  returning true;
$function$;

alter table public.push_server_config enable row level security;
alter table public.ai_phone_cloud_meta enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;
alter table public.push_outbox enable row level security;
alter table public.push_shortcut_commands enable row level security;
alter table public.push_bridge_config enable row level security;
alter table public.push_bridge_snapshots enable row level security;
alter table public.push_screen_threads enable row level security;
alter table public.push_chat_mirror enable row level security;
alter table public.push_api_usage enable row level security;
alter table public.push_api_limits enable row level security;
alter table public.push_recheck_plans enable row level security;

-- 聊天镜像只由网关的 service_role 读写；anon/authenticated 无任何权限。
revoke all on table public.push_chat_mirror from public, anon, authenticated;
revoke all on table public.push_api_usage from public, anon, authenticated;
revoke all on table public.push_api_limits from public, anon, authenticated;

-- 屏幕速聊表和 RPC 只由 Edge Function 的 service_role 使用；客户端角色没有表级权限。
revoke all on table public.push_screen_threads from public, anon, authenticated;
revoke all on table public.push_recheck_plans from public, anon, authenticated;

-- 2026 年起新项目不会自动把 public 新表暴露给 Data API。
-- 网关和生成器只以 service_role 访问，绝不授予 anon 或 authenticated。
grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.push_server_config,
  public.ai_phone_cloud_meta,
  public.push_subscriptions,
  public.push_jobs,
  public.push_outbox,
  public.push_shortcut_commands,
  public.push_bridge_config,
  public.push_bridge_snapshots,
  public.push_screen_threads,
  public.push_chat_mirror,
  public.push_recheck_plans,
  public.push_api_usage,
  public.push_api_limits
to service_role;

revoke all on function public.ai_phone_screen_chat_begin(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.ai_phone_screen_chat_finish(text, text, text, jsonb, integer, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ai_phone_screen_chat_abort(text, text, text) from public, anon, authenticated;
grant execute on function public.ai_phone_screen_chat_begin(text, text, text, text, integer) to service_role;
grant execute on function public.ai_phone_screen_chat_finish(text, text, text, jsonb, integer, text, text, text, text, jsonb) to service_role;
grant execute on function public.ai_phone_screen_chat_abort(text, text, text) to service_role;

-- App 回执云端裁决：只清 at <= p_before 的那批，在数据库里原子过滤，GET 之后新到的裁决留着下次取
create or replace function public.push_recheck_ack_decisions(
  p_user_id text, p_character_id text, p_plan_date text, p_before numeric
) returns void language plpgsql security invoker as $$
begin
 -- Acknowledgement only removes imported diagnostics; it does not change plan meaning.
 perform set_config('float.ack_decisions','1',true);
 update public.push_recheck_plans set decisions=coalesce((select jsonb_agg(d) from jsonb_array_elements(decisions) d
  where coalesce((d->>'at')::numeric,0)>p_before),'[]'::jsonb)
 where user_id=p_user_id and character_id=p_character_id and (p_plan_date='' or plan_date=p_plan_date);
 perform set_config('float.ack_decisions','0',true);
end $$;
grant execute on function public.push_recheck_ack_decisions(text, text, text, numeric) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
  from cron.job
 where jobname = 'ai-phone-personal-push-jobs-scan';

-- 每分钟扫描一次到期任务。任务到点后最晚 60 秒被派发，对离线兜底推送足够；
-- 相比 10 秒一扫，cron.job_run_details 日志量降到 1/6，数据库更省。
-- bridge_scan（现实桥收件箱扫描）派给 push-bridge，其余派给 push-generate。
select cron.schedule('ai-phone-personal-push-jobs-scan', '* * * * *', $CRON$
  update public.push_jobs
     set status = 'pending', updated_at = now()
   where status = 'running' and updated_at < now() - interval '20 minutes';

  select net.http_post(
    url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/push-generate',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id
      from public.push_jobs
     where status = 'pending' and execute_at <= now() and kind <> 'bridge_scan'
     order by execute_at asc
     limit 10
  ) j;

  select net.http_post(
    url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/push-bridge',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id
      from public.push_jobs
     where status = 'pending' and execute_at <= now() and kind = 'bridge_scan'
     order by execute_at asc
     limit 5
  ) j;
$CRON$);

select cron.unschedule(jobid)
  from cron.job
 where jobname = 'ai-phone-personal-push-recheck-scan';

-- 云端动态复核：每 5 分钟挑几份计划交给 push-recheck。这里只负责派发，
-- 「有没有新聊天、要不要真发 LLM 判断」全在函数里决定，省得 cron 里塞逻辑。
-- 醒来本身几乎不花钱（每天 288 次，Supabase 免费额度 50 万/月）；真正计费的模型调用
-- 由函数里的 gateDailyCap / gateGapMin / 配速 卡着，跟这里的频率无关。
-- 挂念选「早上定完」模式的话，改回 '*/30 * * * *' 就行。
-- 不按 plan_date 过滤：plan_date 是用户本地日期，和数据库的 UTC now() 对不上。
select cron.schedule('ai-phone-personal-push-recheck-scan', '*/5 * * * *', $CRON$
  select net.http_post(
    url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/push-recheck',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'userId', p.user_id,
      'characterId', p.character_id,
      'planDate', p.plan_date,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select user_id, character_id, plan_date
      from public.push_recheck_plans
     where updated_at > now() - interval '36 hours'
       and not retry_stopped and (next_retry_at is null or next_retry_at <= now())
       and (last_recheck_at is null or last_recheck_at < now() - interval '4 minutes')
     order by last_recheck_at asc nulls first
     limit 5
  ) p;
$CRON$);

-- pg_cron 运行日志清理：只保留最近 3 天，防止 cron.job_run_details 无限增长。
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'ai-phone-personal-push-cron-cleanup';

select cron.schedule('ai-phone-personal-push-cron-cleanup', '0 3 * * *', $CRON$
  delete from cron.job_run_details where end_time < now() - interval '3 days';
  delete from public.push_chat_mirror where message_at < now() - interval '60 days';
  delete from public.push_recheck_plans p where updated_at < now() - interval '7 days'
    and not exists (select 1 from jsonb_array_elements(coalesce(p.items,'[]')) w join public.push_jobs j
      on j.user_id=p.user_id and j.trigger_key='timedwake:'||(w->>'wakeId')
      where w->>'kind'='promise' and j.status in ('pending','running'));
  delete from public.push_api_usage where updated_at < now() - interval '90 days';
$CRON$);


-- 挂念复核开关：只修改 context 中这一项，保留生成原料、回音与并发写入的其他字段。
create or replace function public.push_recheck_set_enabled(
  p_user_id text, p_character_id text, p_from_date text, p_enabled boolean, p_owner text
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected integer;
begin
  perform 1 from public.push_recheck_plans
    where user_id = p_user_id and character_id = p_character_id and plan_date >= p_from_date
    for update;
  if exists (
    select 1 from public.push_recheck_plans
      where user_id = p_user_id and character_id = p_character_id and plan_date >= p_from_date
        and coalesce(context->>'owner', '') <> '' and context->>'owner' <> coalesce(p_owner, '')
  ) then return -1; end if;
  update public.push_recheck_plans
    set context = jsonb_set(coalesce(context, '{}'::jsonb), '{recheckEnabled}', to_jsonb(case when p_enabled then 1 else 0 end), true),
        updated_at = now()
    where user_id = p_user_id and character_id = p_character_id and plan_date >= p_from_date;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.push_recheck_set_enabled(text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.push_recheck_set_enabled(text, text, text, boolean, text) to service_role;


-- 只停用尚未执行的生成原料；已应用的日程、计划和 push_jobs 保持原样。
create or replace function public.push_recheck_stop_generation(
  p_user_id text, p_character_id text, p_from_date text, p_owner text
) returns integer
language plpgsql security invoker set search_path = public
as $$
declare affected integer;
begin
  perform 1 from public.push_recheck_plans
    where user_id = p_user_id and character_id = p_character_id and plan_date >= p_from_date
      and jsonb_typeof(context->'genKit') = 'object' and coalesce(context->>'generatedBy', '') <> 'cloud'
    for update;
  if exists (
    select 1 from public.push_recheck_plans
      where user_id = p_user_id and character_id = p_character_id and plan_date >= p_from_date
        and jsonb_typeof(context->'genKit') = 'object' and coalesce(context->>'generatedBy', '') <> 'cloud'
        and coalesce(context->>'owner', '') <> '' and context->>'owner' <> coalesce(p_owner, '')
  ) then return -1; end if;
  update public.push_recheck_plans
    set context = jsonb_set(context, '{genEnabled}', '0'::jsonb, true), updated_at = now()
    where user_id = p_user_id and character_id = p_character_id and plan_date >= p_from_date
      and jsonb_typeof(context->'genKit') = 'object' and coalesce(context->>'generatedBy', '') <> 'cloud';
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.push_recheck_stop_generation(text, text, text, text) from public, anon, authenticated;
grant execute on function public.push_recheck_stop_generation(text, text, text, text) to service_role;

-- BEGIN GUANIAN EVENTS SCHEMA 11
alter table public.push_chat_mirror add column if not exists response_batch_id text;
create index if not exists push_chat_mirror_session_idx on public.push_chat_mirror(user_id, session_id, message_at desc);
create index if not exists push_outbox_session_idx on public.push_outbox(user_id, session_id, created_at desc);

-- Independent of the app's device owner: serialize generation for one chat session.
create table if not exists public.push_generation_locks (
  user_id text not null, session_id text not null, token text not null,
  expires_at timestamptz not null, primary key(user_id, session_id)
);
alter table public.push_generation_locks enable row level security;
revoke all on public.push_generation_locks from anon, authenticated;
create or replace function public.push_generation_lease(p_user_id text, p_session_id text, p_token text, p_action text)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  if coalesce(p_session_id,'')='' or coalesce(p_token,'')='' then return false; end if;
  if p_action='release' then
    delete from push_generation_locks where user_id=p_user_id and session_id=p_session_id and token=p_token;
    return true;
  end if;
  if p_action='renew' then
    update push_generation_locks set expires_at=now()+interval '10 minutes'
      where user_id=p_user_id and session_id=p_session_id and token=p_token and expires_at>now();
    get diagnostics n=row_count;
    return n>0;
  end if;
  if p_action<>'claim' then return false; end if;
  insert into push_generation_locks values(p_user_id,p_session_id,p_token,now()+interval '10 minutes')
  on conflict(user_id,session_id) do update set token=excluded.token, expires_at=excluded.expires_at
  where push_generation_locks.token=p_token or (p_action='claim' and push_generation_locks.expires_at<now());
  get diagnostics n=row_count;
  return n>0;
end $$;
revoke all on function public.push_generation_lease(text,text,text,text) from public,anon,authenticated;
grant execute on function public.push_generation_lease(text,text,text,text) to service_role;

-- Ledger revision, job insertion and timeline attachment succeed in one transaction.
create or replace function public.push_arm_promise(
  p_user_id text,p_character_id text,p_date text,p_thread_id text,p_revision integer,p_item jsonb,p_payload jsonb
) returns boolean language plpgsql security definer set search_path=public as $$
declare r public.push_recheck_plans; t jsonb; w jsonb; next_items jsonb:='[]'; key text; actual_at timestamptz;
begin
  select * into r from push_recheck_plans where user_id=p_user_id and character_id=p_character_id and plan_date=p_date for update;
  if not found or r.context->>'recheckEnabled'='0' then return false; end if;
  select value into t from jsonb_array_elements(coalesce(r.context->'threads','[]')) where value->>'id'=p_thread_id;
  if t is null or t->>'kind'<>'promise' or t->>'done'='true' or t->>'status' in ('completed','cancelled')
    or coalesce((t->>'revision')::integer,1)<>p_revision then return false; end if;
  for w in select value from jsonb_array_elements(coalesce(r.items,'[]')) loop
    if w->>'from'=p_thread_id and w->>'kind'='promise' and w->>'act'='true' then
      if coalesce((w->>'promiseRevision')::integer,1)=p_revision then return true; end if;
      update push_jobs set status='cancelled',result_note='promise rescheduled',updated_at=now()
        where user_id=p_user_id and trigger_key='timedwake:'||(w->>'wakeId') and status='pending';
      w:=w||'{"act":false,"why":"约定已改期"}'::jsonb;
    end if;
    next_items:=next_items||jsonb_build_array(w);
  end loop;
  -- Carry the same task across daily plans, including legacy locally-created IDs.
  select entry.value into t from push_recheck_plans p cross join lateral jsonb_array_elements(coalesce(p.items,'[]')) entry
    join push_jobs j on j.user_id=p.user_id and j.trigger_key='timedwake:'||(entry.value->>'wakeId')
    where p.user_id=p_user_id and p.character_id=p_character_id and p.plan_date<>p_date
      and entry.value->>'kind'='promise' and entry.value->>'from'=p_thread_id and entry.value->>'act'='true'
      and coalesce((entry.value->>'promiseRevision')::integer,1)=p_revision and j.status<>'cancelled'
    order by p.plan_date desc limit 1;
  if t is not null then p_item:=t; end if;
  select value into t from jsonb_array_elements(coalesce(r.context->'threads','[]')) where value->>'id'=p_thread_id;
  key:='timedwake:'||(p_item->>'wakeId');
  actual_at:=to_timestamp((p_item->>'fireAt')::numeric/1000);
  insert into push_jobs(id,user_id,trigger_key,kind,execute_at,status,payload)
    values('job_'||gen_random_uuid()::text,p_user_id,key,'timed_task',actual_at,'pending',p_payload)
    on conflict(user_id,trigger_key) do nothing;
  update push_recheck_plans set items=next_items||jsonb_build_array(p_item),
    decisions=coalesce(r.decisions,'[]')||jsonb_build_array(jsonb_build_object('at',extract(epoch from now())*1000,
      'time',p_item->>'time','wakeId',p_item->>'wakeId','kind','promise','by','cloud','note','按约定时间预约：'||(t->>'text')))
    where user_id=p_user_id and character_id=p_character_id and plan_date=p_date;
  return true;
end $$;
revoke all on function public.push_arm_promise(text,text,text,text,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.push_arm_promise(text,text,text,text,integer,jsonb,jsonb) to service_role;
create or replace function public.push_cancel_stale_promises(p_user_id text,p_character_id text,p_threads jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  update push_jobs j set status='cancelled',result_note='promise changed or settled',updated_at=now()
  where j.user_id=p_user_id and j.status='pending' and exists(
    select 1 from push_recheck_plans p,
      lateral jsonb_array_elements(coalesce(p.items,'[]')) w,
      lateral jsonb_array_elements(coalesce(p_threads,'[]')) t
    where p.user_id=p_user_id and p.character_id=p_character_id
      and w->>'kind'='promise' and t->>'kind'='promise' and w->>'from'=t->>'id'
      and j.trigger_key='timedwake:'||(w->>'wakeId')
      and (w->>'act'='false' or t->>'done'='true' or t->>'status' in ('completed','cancelled')
        or coalesce((w->>'promiseRevision')::integer,1)<>coalesce((t->>'revision')::integer,1))
  );
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.push_cancel_stale_promises(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.push_cancel_stale_promises(text,text,jsonb) to service_role;

-- Promise state is durable across whole-plan uploads, resets and cloud PATCHes.
-- Ordinary timeline items and non-promise ledger entries keep their existing semantics.
create or replace function public.push_merge_promise_threads(p_existing jsonb,p_incoming jsonb)
returns jsonb language plpgsql immutable set search_path=public as $$
declare result jsonb:=coalesce(p_incoming,'[]'); old jsonb; fresh jsonb; winner jsonb;
begin
 for old in select value from jsonb_array_elements(coalesce(p_existing,'[]')) where value->>'kind'='promise' loop
  select value into fresh from jsonb_array_elements(result) where value->>'id'=old->>'id';
  if fresh is null then result:=result||jsonb_build_array(old); continue; end if;
  if coalesce((old->>'revision')::integer,1)>coalesce((fresh->>'revision')::integer,1)
   or (coalesce((old->>'revision')::integer,1)=coalesce((fresh->>'revision')::integer,1)
    and (coalesce((old->>'at')::numeric,0)>coalesce((fresh->>'at')::numeric,0)
      or old->>'done'='true')) then winner:=old;
  else winner:=fresh; end if;
  if coalesce((old->>'revision')::integer,1)=coalesce((fresh->>'revision')::integer,1) then
   if coalesce(old->>'nudge','') like '%said:%' then winner:=winner||jsonb_build_object('nudge',old->'nudge'); end if;
   winner:=winner||jsonb_build_object('mentionedAt',greatest(coalesce((old->>'mentionedAt')::numeric,0),coalesce((fresh->>'mentionedAt')::numeric,0)));
  end if;
  select coalesce(jsonb_agg(case when value->>'id'=old->>'id' then winner else value end),'[]') into result from jsonb_array_elements(result);
 end loop;
 return result;
end $$;
revoke all on function public.push_merge_promise_threads(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.push_merge_promise_threads(jsonb,jsonb) to service_role;

create or replace function public.push_preserve_promise_state()
returns trigger language plpgsql security definer set search_path=public as $$
declare threads jsonb:=coalesce(new.context->'threads','[]'); prior jsonb:='[]'; result jsonb:='[]';
 p jsonb; w jsonb; incoming jsonb; t jsonb; previous jsonb;
begin
 -- Include other days: uploading tomorrow's old snapshot must not roll back today's revision.
 for p in select context->'threads' from push_recheck_plans where user_id=new.user_id
   and character_id=new.character_id and plan_date<>new.plan_date order by plan_date desc limit 32 loop
  threads:=push_merge_promise_threads(p,threads);
 end loop;
 if tg_op='UPDATE' then
  threads:=push_merge_promise_threads(old.context->'threads',threads);
  prior:=coalesce(old.items,'[]');
 end if;
 new.context:=jsonb_set(coalesce(new.context,'{}'),'{threads}',threads);
 select coalesce(jsonb_agg(value),'[]') into result from jsonb_array_elements(coalesce(new.items,'[]')) where coalesce(value->>'kind','')<>'promise';
 -- Existing IDs win over a second scheduler. Keep inactive IDs as evidence for cancellation.
 for w in select value from jsonb_array_elements(prior||coalesce(new.items,'[]')) where value->>'kind'='promise' loop
  if coalesce(w->>'wakeId','')='' then continue; end if;
  if exists(select 1 from jsonb_array_elements(result) where value->>'wakeId'=w->>'wakeId') then continue; end if;
  select value into incoming from jsonb_array_elements(coalesce(new.items,'[]')) where value->>'wakeId'=w->>'wakeId';
  if incoming is not null then
   previous:=w; w:=w||incoming;
   if previous->>'act'='false' then w:=w||'{"act":false}'::jsonb; end if;
   if coalesce((previous->>'generatedAt')::numeric,0)>0 then w:=w||jsonb_build_object('generatedAt',previous->'generatedAt'); end if;
  end if;
  select value into t from jsonb_array_elements(threads) where value->>'id'=w->>'from' and value->>'kind'='promise';
  if t is null or t->>'done'='true' or t->>'status' in ('completed','cancelled')
    or coalesce((t->>'revision')::integer,1)<>coalesce((w->>'promiseRevision')::integer,1)
    or exists(select 1 from jsonb_array_elements(result) x where x->>'kind'='promise' and x->>'act'='true'
      and x->>'from'=w->>'from' and coalesce((x->>'promiseRevision')::integer,1)=coalesce((w->>'promiseRevision')::integer,1)) then
   w:=w||'{"act":false,"why":"约定已更新或已有同版本预约"}'::jsonb;
  end if;
  result:=result||jsonb_build_array(w);
 end loop;
 new.items:=result;
 return new;
end $$;
drop trigger if exists push_preserve_promise_state on public.push_recheck_plans;
create trigger push_preserve_promise_state before insert or update of context,items on public.push_recheck_plans
 for each row execute function public.push_preserve_promise_state();

create or replace function public.push_cancel_changed_promise_state()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform push_cancel_stale_promises(new.user_id,new.character_id,new.context->'threads');
 return new;
end $$;
drop trigger if exists push_cancel_changed_promise_state on public.push_recheck_plans;
create trigger push_cancel_changed_promise_state after insert or update of context,items on public.push_recheck_plans
 for each row execute function public.push_cancel_changed_promise_state();

-- Read-only migration probe: a missing RPC fails before the gateway saves any plan.
create or replace function public.push_promise_storage_ready() returns boolean language sql stable security definer set search_path=public as $$
 select count(*)=2 from pg_trigger where tgrelid='public.push_recheck_plans'::regclass
 and tgname in ('push_preserve_promise_state','push_cancel_changed_promise_state') and tgenabled<>'D';
$$;
revoke all on function public.push_promise_storage_ready() from public,anon,authenticated;
grant execute on function public.push_promise_storage_ready() to service_role;

-- END GUANIAN EVENTS SCHEMA 11

-- 独立于设备所有权及整份 context 上传的判断租约/聊天游标。
alter table public.push_recheck_plans add column if not exists judge_token text;
alter table public.push_recheck_plans add column if not exists judge_until timestamptz;
alter table public.push_recheck_plans add column if not exists judged_chat_at bigint not null default 0;
alter table public.push_recheck_plans add column if not exists judged_at bigint not null default 0;
create or replace function public.push_recheck_judge(
 p_user_id text, p_character_id text, p_date text, p_token text, p_action text,
 p_chat_at bigint default 0, p_success boolean default false
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.push_recheck_plans%rowtype; stamp bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
 select * into r from public.push_recheck_plans where user_id=p_user_id and character_id=p_character_id and plan_date=p_date for update;
 if not found then return jsonb_build_object('claimed',false,'reason','no-plan'); end if;
 if p_action='finish' then
  if r.judge_token is distinct from p_token then
   if p_success and p_chat_at>0 and r.judged_chat_at>=p_chat_at then return jsonb_build_object('claimed',true,'reason','already-finished'); end if;
   return jsonb_build_object('claimed',false,'reason','lost');
  end if;
  update public.push_recheck_plans set judge_token=null, judge_until=null,
   judged_chat_at=case when p_success then greatest(judged_chat_at, least(p_chat_at,stamp)) else judged_chat_at end,
   judged_at=case when p_success then stamp else judged_at end
   where user_id=p_user_id and character_id=p_character_id and plan_date=p_date;
  return jsonb_build_object('claimed',true);
 end if;
 if p_action not in ('claim','renew') or coalesce(p_token,'')='' then raise exception 'invalid judge action'; end if;
 if (p_action='renew' and r.judge_token is distinct from p_token) or
    (r.judge_token is distinct from p_token and r.judge_until>now()) then
  return jsonb_build_object('claimed',false,'reason','busy','chatAt',r.judged_chat_at,'judgedAt',r.judged_at);
 end if;
 if p_action='claim' and p_chat_at>0 and p_chat_at<=r.judged_chat_at then
  return jsonb_build_object('claimed',false,'reason','handled','chatAt',r.judged_chat_at,'judgedAt',r.judged_at);
 end if;
 update public.push_recheck_plans set judge_token=p_token, judge_until=now()+interval '10 minutes'
  where user_id=p_user_id and character_id=p_character_id and plan_date=p_date;
 return jsonb_build_object('claimed',true,'chatAt',r.judged_chat_at,'judgedAt',r.judged_at);
end $$;
revoke all on function public.push_recheck_judge(text,text,text,text,text,bigint,boolean) from public,anon,authenticated;
grant execute on function public.push_recheck_judge(text,text,text,text,text,bigint,boolean) to service_role;
