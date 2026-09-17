// 快捷动作结果续跑：拿到会话租约后读最新聊天，生成正文先落盘，再独立重试交付。
// 停用/取消与每个发送边界共用守卫；原消息和动作未交付时不提前续跑。
import { deleteShortcutImage, formatShortcutResult, injectShortcutImage, readShortcutImage, replaceMarker, stripShortcutMarkers, type CloudCtx, type ShortcutCommandRow } from "./delivery.ts";
import { assertDeliveryActive, checkDelivery, DeliveryPaused } from "./delivery-guard.ts";
import type { EngineDeps } from "./engine.ts";
import { acquireGenerationLease, GenerationBusy } from "./generation-lease.ts";
import { historyText, readHistory } from "./history.ts";
import { appendUserNote, callModel, splitPreview, usageAdd, usageBudget, usageExceeded, visibleResponse } from "./llm.ts";
import type { ShortcutResume } from "./store.ts";
import { fillChatTemplate } from "./templates.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function runShortcutResumes(deps: EngineDeps): Promise<number> {
  let handled = 0;
  for (const r of deps.store.dueResumes(deps.now())) {
    if (r.failed) continue;
    try {
      if (await resumeOne(deps, r)) handled += 1;
    } catch (e) {
      if (e instanceof DeliveryPaused || e instanceof GenerationBusy) {
        r.dueAt = deps.now() + 60_000;
        if (r.pauseReason !== e.message) deps.store.addDecision(r.characterId, "hold", e.message, "live", { commandId: r.commandId }, deps.now());
        r.pauseReason = e.message;
      } else {
        r.tries += 1;
        r.dueAt = deps.now() + 5 * 60_000;
        if (r.tries >= 3) {
          // 保留已生成正文和诊断，不能在重试耗尽时把恢复材料删掉。
          r.failed = true; r.dueAt = Number.MAX_SAFE_INTEGER;
        }
        deps.store.addDecision(r.characterId, "error", `快捷动作「${r.actionName}」续跑失败${r.failed ? "，保留记录待核对" : "，稍后重试"}：${errText(e)}`, "live", { commandId: r.commandId }, deps.now());
      }
      deps.store.updateResume(r);
    }
  }
  return handled;
}

async function resumeOne(deps: EngineDeps, r: ShortcutResume): Promise<boolean> {
  const parent = deps.store.shortcutDraft(r.commandId);
  const wakeId = r.sourceWakeId || parent?.wakeId || "";
  // 离线任务建的命令：角色不一定在挂念名单里，只靠会话租约
  const fromJob = !!r.sourceJobKey;
  if (!fromJob) assertDeliveryActive(deps, r.characterId, r.sessionId, wakeId);
  // 兼容旧版先挂续跑再交付动作的记录。
  if (parent && !parent.shortcutDelivered) throw new DeliveryPaused("首条消息或快捷动作尚未交付，等待恢复");
  const lease = await acquireGenerationLease(deps.rest, deps.userId, r.sessionId, "shortcut:" + r.commandId);
  const guard = () => fromJob ? lease.check() : checkDelivery(deps, r.characterId, r.sessionId, wakeId, lease);
  const cc: CloudCtx | null = deps.cloud ? { rest: deps.rest, cloud: deps.cloud, key: deps.cloudKey || "", userId: deps.userId } : null;
  const scope = `user_id=eq.${encodeURIComponent(deps.userId)}`;
  try {
    await guard();
    const existing = await deps.rest(`push_outbox?${scope}&id=eq.${encodeURIComponent(r.outboxId)}&select=id&limit=1`);
    if (!existing.ok) throw new Error(`续跑凭据读取失败 HTTP ${existing.status}`);
    const receipts = await existing.json();
    if (!Array.isArray(receipts)) throw new Error("续跑凭据格式错误");
    if (receipts.length) {
      if (cc && r.generated?.imagePath) { await guard(); await deleteShortcutImage(cc, r.generated.imagePath); }
      deps.store.deleteResume(r.commandId);
      return true;
    }
    if (!r.generated) {
      const response = await deps.rest(`push_shortcut_commands?id=eq.${encodeURIComponent(r.commandId)}&${scope}&select=id,status,action_name,result_mode,result,error,expires_at&limit=1`);
      if (!response.ok) throw new Error(`快捷命令读取失败 HTTP ${response.status}`);
      const [command] = await response.json() as ShortcutCommandRow[];
      if (!command) throw new Error("快捷命令不见了，无法核对结果");
      const nowMs = deps.now();
      if (command.status === "pending" || command.status === "claimed") {
        const expiresAt = Date.parse(command.expires_at);
        if (!Number.isFinite(expiresAt)) throw new Error("快捷命令过期时间无效");
        if (expiresAt > nowMs) {
          r.dueAt = Math.min(expiresAt + 5_000, nowMs + 15_000);
          deps.store.updateResume(r);
          return false;
        }
        command.status = "expired"; command.error = "等待手机执行超时。";
      }
      const c = fromJob ? null : deps.store.getCharacter(r.characterId)!;
      const window = c ? { ...c.settings, ...c.state } : undefined;
      const history = await readHistory(deps.rest, deps.userId, r.sessionId, window);
      const tz = Number(c?.settings.tzOffsetMin ?? r.merge.tzOffsetMin) || 0;
      const request = fillChatTemplate(r.request, { tzOffsetMin: tz }, { intent: "", elapsedMin: 0, nowMs });
      if (!replaceMarker(request.body, r.resultMarker, formatShortcutResult(command))) throw new Error("续跑底稿缺少结果占位");
      appendUserNote(request.body, request.providerKind, `[最新聊天事实，非用户新消息；当前当地时间 ${new Date(nowMs + tz * 60000).toISOString().slice(0, 16)}。与旧底稿冲突时以此为准；用户取消的事情不要继续催促或执行。]\n`
        + historyText(history, tz, 80, window));
      let imagePath = "";
      if (r.imageMarker) {
        const read = cc ? await readShortcutImage(cc, command) : { image: null, path: "" };
        imagePath = read.path;
        injectShortcutImage(request.body, request.providerKind, r.imageMarker, read.image);
      }
      const budget = await usageBudget(deps.rest, deps.userId, nowMs);
      const over = fromJob ? "" : usageExceeded(budget);
      if (over) throw new DeliveryPaused(over);
      await guard();
      const result = await callModel(request, deps.fetchModel, 300_000);
      try {
        const parsed = visibleResponse(result.text.trim(), r.merge.onlineThinking);
        const rawText = parsed.text.trim() ? stripShortcutMarkers(parsed.text.trim()) : "";
        if (!rawText) throw new Error("结果续跑回复是空的");
        r.generated = { rawText, createdAt: new Date(deps.now()).toISOString(), ...(parsed.reasoningText ? { reasoningText: parsed.reasoningText } : {}), ...(imagePath ? { imagePath } : {}) };
        deps.store.updateResume(r);
      } finally {
        await usageAdd(deps.rest, deps.userId, budget.tz, fromJob ? "cloud-chat" : "cloud-wake", request.providerKind, result.data);
      }
    }
    await guard();
    const { rawText, createdAt, reasoningText, imagePath } = r.generated;
    const saved = await deps.rest("push_outbox", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ id: r.outboxId, user_id: deps.userId, job_id: null, session_id: r.sessionId, trigger_key: `shortcut:${r.commandId}`, raw_text: rawText, created_at: createdAt,
        meta: { ...r.merge, sessionId: r.sessionId, pushGenerated: true, companionServer: true, companionDeliveredAt: new Date(deps.now()).toISOString(), ...(reasoningText ? { reasoningText } : {}) } }]),
    });
    if (!saved.ok) throw new Error(`outbox 写入失败 HTTP ${saved.status}`);
    await guard();
    const parts = splitPreview(rawText).slice(0, 6);
    const pushed = await deps.push((parts.length ? parts : ["发来一条消息"]).map((body, index) => ({
      type: "chat_outbox", title: r.notify.title, body: body.slice(0, 80), tag: `${r.commandId}-${index}`, url: r.notify.url || "/", characterId: r.characterId,
    }))).catch(e => ({ sent: 0, total: 0, removed: 0, skippedShell: 0, errors: [errText(e)] }));
    if (cc && imagePath) { await guard(); await deleteShortcutImage(cc, imagePath); }
    deps.store.deleteResume(r.commandId);
    deps.store.addDecision(r.characterId, "send", `快捷动作「${r.actionName}」结果回来了，接着说：${rawText.replace(/\s+/g, " ").slice(0, 60)}`, "live",
      { commandId: r.commandId, outboxId: r.outboxId, pushed: pushed.sent, pushErrors: pushed.errors }, deps.now());
    return true;
  } finally { await lease.release(); }
}
