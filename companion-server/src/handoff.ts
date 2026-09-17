// 交接前停掉旧云端调度；只用已有 schema 12 RPC，不改角色的日程/账本/发送凭据。
import { decryptPayload, type EncryptedPayload } from "./crypto.ts";
import type { Rest } from "./supabase.ts";

export const LEGACY_HANDOFF_NOTE = "handed off to companion server";

type Plan = { judge_until?: string; last_recheck_at?: string; session_id: string; context: Record<string, any>; items: { wakeId?: string }[] };
type Job = { id: string; trigger_key: string; status: string; updated_at: string; payload: EncryptedPayload };
const fail = (message: string) => Object.assign(new Error(message), { status: 409 });

async function json<T>(rest: Rest, path: string, init?: RequestInit): Promise<T> {
  const r = await rest(path, init);
  if (!r.ok) throw fail(`旧云端交接失败（${path.split("?")[0]} HTTP ${r.status}），未启用 VPS`);
  return await r.json() as T;
}

export async function stopLegacyScheduler(rest: Rest, userId: string, characterId: string, owner: string): Promise<void> {
  const scope = `user_id=eq.${encodeURIComponent(userId)}`;
  const planPath = `push_recheck_plans?${scope}&character_id=eq.${encodeURIComponent(characterId)}`;
  const plans: Plan[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await json<Plan[]>(rest, `${planPath}&select=session_id,context,items,judge_until,last_recheck_at&order=plan_date&limit=200&offset=${offset}`);
    if (!Array.isArray(page)) throw fail("旧云端计划格式异常");
    plans.push(...page);
    if (page.length < 200) break;
  }
  for (const action of ["push_recheck_set_enabled", "push_recheck_stop_generation"]) {
    const count = await json<number>(rest, "rpc/" + action, { method: "POST", body: JSON.stringify({
      p_user_id: userId, p_character_id: characterId, p_from_date: "0000-01-01", p_owner: owner,
      ...(action === "push_recheck_set_enabled" ? { p_enabled: false } : {}),
    }) });
    if (!Number.isInteger(count) || count < 0) throw fail("旧云端未确认停用，或计划由其他设备负责");
  }
  // 已停开关，但旧 worker 可能还在模型调用里。保留它的成文，不抢交付。
  const now = Date.now();
  const busy = (p: Plan) => Date.parse(p.judge_until || "") > now
    || p.context?.genKit && p.context.generatedBy !== "cloud" && now - Date.parse(p.last_recheck_at || "") < 10 * 60_000;
  if (plans.some(busy)) throw fail("旧云端仍在判断或生成，请结束后重试交接");
  const known = new Set(plans.flatMap(p => [...(p.items || []).map(i => i.wakeId), p.context?.sentinelWakeId].filter(Boolean)).map(id => "timedwake:" + id));
  const sessions = new Set(plans.map(p => p.session_id).filter(Boolean));
  let key = "";
  const active = async (): Promise<Job[]> => {
    const jobs: Job[] = [];
    // 扫所有挂念待执行任务，不能只看诊断接口最近 20 条。先读全再修改，避免分页偏移跳行。
    for (let offset = 0; ; offset += 200) {
      const rows = await json<Job[]>(rest, `push_jobs?${scope}&kind=eq.timed_task&status=in.(pending,running)&trigger_key=like.timedwake:timed_wake_capp_*gua.nian*&select=id,trigger_key,status,updated_at,payload&order=id&limit=200&offset=${offset}`);
      if (!Array.isArray(rows)) throw fail("旧云端任务格式异常");
      jobs.push(...rows);
      if (rows.length < 200) break;
    }
    const own: Job[] = [];
    for (const job of jobs) {
      if (!key) {
        const [cfg] = await json<{ payload_key?: string }[]>(rest, "push_server_config?id=eq.main&select=payload_key&limit=1");
        key = cfg?.payload_key || "";
      }
      let payload;
      try { payload = JSON.parse(await decryptPayload(job.payload, key)); }
      catch { throw fail("无法核对旧预约身份及成文状态，交接未完成"); }
      const cid = payload.notify?.characterId;
      if (!known.has(job.trigger_key) && (cid ? cid !== characterId : !sessions.has(payload.merge?.sessionId))) continue;
      if (job.status === "running" || payload.generatedResponse) throw fail("旧云端还有正在执行或等待投递的消息，请结束后重试交接");
      const output = await json<unknown[]>(rest, `push_outbox?${scope}&job_id=eq.${encodeURIComponent(job.id)}&select=id&limit=1`);
      if (!Array.isArray(output) || output.length) throw fail("旧预约已有投递凭据但尚未结算，请核对后重试交接");
      own.push(job);
    }
    return own;
  };
  for (const job of await active()) {
    const changed = await json<Job[]>(rest, `push_jobs?${scope}&id=eq.${encodeURIComponent(job.id)}&status=eq.pending&updated_at=eq.${encodeURIComponent(job.updated_at)}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "cancelled", result_note: LEGACY_HANDOFF_NOTE, updated_at: new Date().toISOString() }),
    });
    if (!Array.isArray(changed) || changed.length !== 1) throw fail("旧预约状态在交接时变化，请重试；未启用 VPS");
  }
  if ((await active()).length) throw fail("旧云端仍有待发预约，请重试交接");
  for (let offset = 0; ; offset += 200) {
    const rows = await json<Plan[]>(rest, `${planPath}&select=context,judge_until,last_recheck_at&order=plan_date&limit=200&offset=${offset}`);
    if (!Array.isArray(rows) || rows.some(p => busy(p) || p.context?.recheckEnabled !== 0 || p.context?.genKit && p.context.generatedBy !== "cloud" && p.context.genEnabled !== 0)) throw fail("旧云端调度开关尚未全部停用");
    if (rows.length < 200) break;
  }
}
