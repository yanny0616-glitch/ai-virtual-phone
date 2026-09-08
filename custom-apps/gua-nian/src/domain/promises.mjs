// Pure event rules, shared by the app and self-contained cloud workers.
export function promiseSubject(value) {
  return ["user", "character", "both"].includes(value) ? value : "user";
}
export function promiseSubjectLabel(value) {
  return { user: "用户", character: "角色", both: "双方" }[promiseSubject(value)];
}
export function promiseAgreementRule() {
  return "标注为线下摘要的记录是双方互动的概述，不是角色原话；可引用摘要编号核对约定，但必须区分摘要中用户的明确同意或拒绝与角色的要求。不能因为摘要由模型生成，就把其全部内容归为角色承诺。用户自己的事情以用户最新明确意愿为准。角色的要求、劝说、坚持、替用户安排时间不等于用户答应，不能建立或恢复 user/both 约定，也不能改记为角色的跟进承诺来继续催。用户明确拒绝或取消时，已有同一件事必须通过 keep 的 id + status=cancelled 更新，不能只在 why 里写取消而仍保留 pending；没有已有事件则不创建。只有用户后来明确重新同意才能恢复，沉默不是同意。sourceMessageId 必须引用下方真实聊天编号：用户或双方约定的成立、改期、恢复要引用用户本人同意的消息；角色自己的承诺要引用角色本人消息；取消引用明确取消的消息。取消优先于同轮旧的同意或角色坚持，相关普通跟进时刻也应取消，不再为同一件事加 extra。";
}
// A cheap wake-up hint, not a parser: the model still checks whether a promise exists.
export function hasPromiseUpdate(messages, threads) {
  return messages.some(m => {
    const text = String(m.content || m.c || "");
    // Only opens semantic review; never cancels a possibly unrelated event by keyword.
    if (m.role === "user" && threads.some(t => t.kind === "promise" && !t.done)
      && /取消|算了|不(?:再|想|用|做|去|需要)|别(?:再|提醒|催|提)/.test(text)) return true;
    return /(?:\d{1,2}[:：]\d{2}|[一二三四五六七八九十两\d]{1,3}[点时]|明天|后天|周[一二三四五六日天])/.test(text)
      && /回|到|约|等|一起|见|答应|记得|提醒|陪|去|再说|联系|找你/.test(text)
      || threads.some(t => t.kind === "promise" && !t.done && text.includes(String(t.text || ""))
        && /改|不去|不回|取消|算了|完成|好了|到了|办完/.test(text));
  });
}
// New assistant messages may update promises, but cannot open the ordinary impulse gate.
export function recheckEvidence(messages, threads, since) {
  const fresh = messages.filter(m => Number(m.t ?? Date.parse(m.message_at || "")) > since);
  const users = fresh.filter(m => m.role === "user");
  const summaries = fresh.filter(m => m.media_type === "offline_summary");
  const updates = [...users, ...summaries];
  const promiseUpdate = hasPromiseUpdate(fresh, threads) || summaries.length > 0;
  return { fresh, users, updates, promiseUpdate, ledgerOnly: updates.length === 0 && promiseUpdate };
}
export function ordinaryQuota(items) {
  return items.filter(w => w.kind !== "promise" && w.act).length;
}
export function updatePromiseThreads(threads, changes, nowMs, by, messages = null) {
  const list = threads.map(t => ({ ...t }));
  for (const k of changes) {
    const id = String(k.id || "").replace(/[\[\]\s]/g, "");
    const text = String(k.text || "").trim().slice(0, 60);
    const subject = promiseSubject(k.subject);
    const old = id ? list.find(t => t.id === id && t.kind === "promise")
      : list.find(t => t.kind === "promise" && promiseSubject(t.subject) === subject && t.text === text);
    // Explicit unknown IDs cannot silently create a second event.
    if (id && !old) continue;
    // Model-produced changes need real speaker evidence. Manual edits use their own UI path.
    if (Array.isArray(messages)) {
      const source = messages.find(m => String(m.id || "") === String(k.sourceMessageId || "") && m.id);
      if (!source) continue;
      const closing = k.status === "completed" || k.status === "cancelled";
      const owner = old ? promiseSubject(old.subject) : subject;
      const nextOwner = k.subject ? subject : owner;
      const summaryEvidence = source.media_type === "offline_summary";
      if (!closing && (owner !== "character" || nextOwner !== "character") && source.role !== "user" && !summaryEvidence) continue;
      if (!closing && owner === "character" && nextOwner === "character" && source.role !== "assistant" && !summaryEvidence) continue;
      if (closing && owner !== "character" && source.role !== "user" && !summaryEvidence) continue;
      // A previously closed event cannot be revived from the same old agreement.
      const sourceAt = Number(source.t ?? Date.parse(source.message_at || ""));
      if (!closing && old?.done && !(sourceAt > Number(old.at || 0))) continue;
    }
    if (k.status === "completed" || k.status === "cancelled") {
      if (old) Object.assign(old, { status: k.status, done: true, at: nowMs, by });
      continue;
    }
    const due = Number(k.due) || Number(old?.due);
    if (!(due > 0) || (!text && !old)) continue;
    if (old) {
      const changed = due !== old.due || (k.subject && subject !== promiseSubject(old.subject)) || old.done;
      Object.assign(old, { text: text || old.text, due, subject: k.subject ? subject : promiseSubject(old.subject),
        sourceMessageId: String(k.sourceMessageId || old.sourceMessageId || "").slice(0, 100),
        status: changed ? "pending" : (old.status || "pending"), done: false, at: nowMs, by,
        revision: (Number(old.revision) || 1) + (changed ? 1 : 0),
        ...(changed ? { nudge: "", mentionedAt: 0 } : {}) });
    } else {
      // Stable within a judgment; no implicit clock or random state.
      let n = list.length;
      let newId;
      do { newId = "p" + nowMs.toString(36) + (n++).toString(36); } while (list.some(t => t.id === newId));
      list.push({ id: newId, kind: "promise", text, due, subject, revision: 1, status: "pending", done: false,
        sourceMessageId: String(k.sourceMessageId || "").slice(0, 100), since: nowMs, at: nowMs, by,
        why: String(k.why || "").slice(0, 40) });
    }
  }
  return list;
}
export function promiseNeedsTask(t, items, nowMs, endMs) {
  return t.kind === "promise" && !t.done && t.status !== "completed" && t.status !== "cancelled"
    && !(Number(t.mentionedAt) > 0) && !/said:/.test(String(t.nudge || ""))
    && Number(t.due) > nowMs - 86400000 && Number(t.due) < endMs
    && !items.some(w => w.from === t.id && w.kind === "promise" && w.act
      && Number(w.promiseRevision || 1) === Number(t.revision || 1));
}
export function promiseIntent(t, localDue) {
  return `核对约定 [${t.id}]：${promiseSubjectLabel(t.subject)}约好在 ${localDue} ${t.text}。`
    + "这是明确约定，到点核对最新时间、双方对话和当前行程。角色自己的承诺应交代进展；用户的事情只能询问，不能替用户宣称完成。"
    + "时间到了不等于事情已完成；有事实支持才能说到了或做完了，延误就按现在的情况说明，不能照搬旧时间。已改期、取消、完成且交代过则作罢。";
}
