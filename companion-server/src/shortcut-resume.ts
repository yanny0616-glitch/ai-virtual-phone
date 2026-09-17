// 快捷动作结果续跑：角色请对方 iPhone 跑了个会回传结果的动作，后端等结果回来，把结果（和截图）代入续跑底稿，
// 生成第二轮写 outbox + 推送。原先是 push-generate 的 shortcut_resume 云任务，规则与文案照搬。
// Runner 每轮跑一次；命令还没执行完就往后排，过期按「等待手机执行超时」交给角色说。

import { deleteShortcutImage, formatShortcutResult, injectShortcutImage, readShortcutImage, replaceMarker, stripShortcutMarkers, type CloudCtx, type ShortcutCommandRow } from "./delivery.ts";
import type { EngineDeps } from "./engine.ts";
import { acquireGenerationLease, GenerationBusy } from "./generation-lease.ts";
import { callModel, splitPreview, usageAdd, usageBudget, visibleResponse } from "./llm.ts";
import type { ShortcutResume } from "./store.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function runShortcutResumes(deps: EngineDeps): Promise<number> {
  let handled = 0;
  for (const r of deps.store.dueResumes(deps.now())) {
    try {
      if (await resumeOne(deps, r)) handled += 1;
    } catch (e) {
      r.tries += 1;
      if (r.tries >= 3) {
        deps.store.deleteResume(r.commandId);
        deps.store.addDecision(r.characterId, "error", `快捷动作「${r.actionName}」的结果续跑失败，放弃：${errText(e)}`, "live", { commandId: r.commandId }, deps.now());
      } else {
        r.dueAt = deps.now() + 5 * 60_000;
        deps.store.updateResume(r);
      }
    }
  }
  return handled;
}

async function resumeOne(deps: EngineDeps, r: ShortcutResume): Promise<boolean> {
  const scope = `user_id=eq.${encodeURIComponent(deps.userId)}`;
  // 上次写进去了但没来得及收尾
  const existing = await deps.rest(`push_outbox?${scope}&id=eq.${encodeURIComponent(r.outboxId)}&select=id&limit=1`);
  if (!existing.ok) throw new Error(`续跑凭据读取失败 HTTP ${existing.status}`);
  if ((await existing.json() as unknown[]).length) { deps.store.deleteResume(r.commandId); return true; }

  const response = await deps.rest(`push_shortcut_commands?id=eq.${encodeURIComponent(r.commandId)}&${scope}&select=id,status,action_name,result_mode,result,error,expires_at&limit=1`);
  if (!response.ok) throw new Error(`快捷命令读取失败 HTTP ${response.status}`);
  const [command] = await response.json() as ShortcutCommandRow[];
  if (!command) {
    deps.store.deleteResume(r.commandId);
    deps.store.addDecision(r.characterId, "error", `快捷动作「${r.actionName}」的命令不见了，不续跑`, "live", { commandId: r.commandId }, deps.now());
    return false;
  }
  const nowMs = deps.now();
  if (command.status === "pending" || command.status === "claimed") {
    const expiresAt = Date.parse(command.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt > nowMs) {
      r.dueAt = Math.min(expiresAt + 5_000, nowMs + 15_000);
      deps.store.updateResume(r);
      return false;
    }
    command.status = "expired";
    command.error = "等待手机执行超时。";
    await deps.rest(`push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}&status=in.(pending,claimed)`, {
      method: "PATCH", body: JSON.stringify({ status: "expired", error: command.error, updated_at: new Date(nowMs).toISOString() }),
    }).catch(() => undefined);
  }

  let lease;
  try { lease = await acquireGenerationLease(deps.rest, deps.userId, r.sessionId, "shortcut:" + r.commandId); }
  catch (e) {
    if (!(e instanceof GenerationBusy)) throw e;
    r.dueAt = nowMs + 60_000;
    deps.store.updateResume(r);
    return false;
  }
  const cc: CloudCtx | null = deps.cloud ? { rest: deps.rest, cloud: deps.cloud, key: deps.cloudKey || "", userId: deps.userId } : null;
  let imagePath = "";
  try {
    const request = structuredClone(r.request);
    if (!replaceMarker(request.body, r.resultMarker, formatShortcutResult(command))) {
      deps.store.deleteResume(r.commandId);
      deps.store.addDecision(r.characterId, "error", `快捷动作「${r.actionName}」续跑底稿里没有结果占位，不续跑`, "live", { commandId: r.commandId }, nowMs);
      return false;
    }
    if (r.imageMarker) {
      const read = cc ? await readShortcutImage(cc, command) : { image: null, path: "" };
      imagePath = read.path;
      injectShortcutImage(request.body, request.providerKind, r.imageMarker, read.image);
    }
    await lease.check();
    const result = await callModel(request, deps.fetchModel, 300_000);
    const budget = await usageBudget(deps.rest, deps.userId, nowMs);
    await usageAdd(deps.rest, deps.userId, budget.tz, "cloud-wake", request.providerKind, result.data);
    let rawText = result.text.trim();
    let reasoning: string | undefined;
    try { const parsed = visibleResponse(rawText, r.merge.onlineThinking); rawText = parsed.text; reasoning = parsed.reasoningText; }
    catch { rawText = ""; }
    // 第二轮再输出动作标记也不执行，防递归
    rawText = rawText ? stripShortcutMarkers(rawText) : "";
    if (!rawText) {
      deps.store.deleteResume(r.commandId);
      deps.store.addDecision(r.characterId, "error", `快捷动作「${r.actionName}」结果回来了，但回复是空的，没发`, "live", { commandId: r.commandId }, nowMs);
      return false;
    }
    await lease.check();
    const createdAt = new Date(deps.now()).toISOString();
    const saved = await deps.rest("push_outbox", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ id: r.outboxId, user_id: deps.userId, job_id: null, session_id: r.sessionId, trigger_key: `shortcut:${r.commandId}`, raw_text: rawText, created_at: createdAt,
        meta: { ...r.merge, sessionId: r.sessionId, pushGenerated: true, companionServer: true, ...(reasoning ? { reasoningText: reasoning } : {}) } }]),
    });
    if (!saved.ok) throw new Error(`outbox 写入失败 HTTP ${saved.status}`);
    deps.store.deleteResume(r.commandId);
    if (cc) await deleteShortcutImage(cc, imagePath);
    const parts = splitPreview(rawText).slice(0, 6);
    const pushed = await deps.push((parts.length ? parts : ["发来一条消息"]).map((body, index) => ({
      type: "chat_outbox", title: r.notify.title, body: body.slice(0, 80), tag: `${r.commandId}-${index}`, url: r.notify.url || "/", characterId: r.characterId,
    }))).catch(e => ({ sent: 0, total: 0, removed: 0, skippedShell: 0, errors: [errText(e)] }));
    deps.store.addDecision(r.characterId, "send", `快捷动作「${r.actionName}」结果回来了，接着说：${rawText.replace(/\s+/g, " ").slice(0, 60)}`, "live",
      { commandId: r.commandId, outboxId: r.outboxId, pushed: pushed.sent, pushErrors: pushed.errors }, deps.now());
    return true;
  } finally {
    await lease.release();
  }
}
