// 回忆选取：哪些拾光进聊天、发什么字。APP 卡片和注入文字共用这里的函数。
import { clean, overlap, estimateTokens } from "./text.mjs";

export const CATEGORIES = ["共同经历", "约定与承诺", "喜好与边界", "人物与关系", "重要信息"];
export const STATUSES = { remembered: "记在心里", pending: "等待兑现", completed: "已经完成", changed: "计划有变" };
export const MODES = { priority: "优先携带", relevant: "按话题回忆", off: "不发送" };

export function isActive(entry) {
  return !!entry && !entry.deletedAt && typeof entry.title === "string";
}

/** 没写摘要时的兜底：旧记录优先用当年模型写的紧凑摘要，再退到卡片事实拼接。 */
export function defaultSummary(entry) {
  const legacy = (entry.legacy && (entry.legacy.recallSummary || entry.legacy.stableSummary) || "").trim();
  if (legacy) return legacy;
  const parts = [entry.title, entry.summary, entry.reason, entry.story, ...(entry.details || []).map(f => `${f.label}：${f.value}`), entry.significance]
    .map(v => (v || "").trim()).filter(Boolean);
  const unique = parts.filter((part, i) => !parts.some((other, j) => j !== i && other.includes(part) && (other.length > part.length || j < i)));
  return unique.join("；");
}

export function recallMode(entry) {
  return entry.recallMode || "relevant";
}

export function promptText(entry) {
  const summary = (entry.promptSummary || "").trim() || defaultSummary(entry);
  const status = { remembered: "", pending: "尚待兑现", completed: "已经完成", changed: "安排已变化" }[entry.status] || "";
  return `${summary}${status ? ` 当前进展：${status}。` : ""}${entry.followup ? ` 最新进展：${entry.followup}` : ""}`;
}

export function promptTokens(entry) {
  return estimateTokens(promptText(entry)) + 4;
}

/**
 * 预算内选记忆。优先携带的先占，但最多占一半预算，剩下留给按话题命中的；
 * 话题项选完还有余量，再让排队的优先项补进来。整条进或整条不进，不截断。
 */
export function selectForPrompt(entries, context, tokenBudget, now = new Date()) {
  const budget = Math.max(0, Math.min(4000, Number.isFinite(tokenBudget) ? tokenBudget : 800));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const cleanContext = clean(context);
  const ranked = entries.filter(isActive).map(entry => {
    const mode = recallMode(entry);
    const due = entry.dueAt ? new Date(entry.dueAt + "T00:00:00").getTime() : NaN;
    const days = (due - today) / 86400000;
    const keywords = entry.keywords || [];
    const relevance = overlap(entry.title + " " + keywords.join(" "), context);
    const keywordHit = keywords.some(k => clean(k).length >= 2 && cleanContext.includes(clean(k)));
    const timely = entry.status === "pending" && days >= -1 && days <= 7;
    return { entry, mode, score: (keywordHit ? 20 : 0) + relevance + (timely ? 15 : 0), relevant: keywordHit || relevance >= 3 || timely };
  }).filter(v => v.mode !== "off" && (v.mode === "priority" || v.relevant));
  const byRecent = (a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt));
  const priority = ranked.filter(v => v.mode === "priority").sort(byRecent);
  const relevant = ranked.filter(v => v.mode !== "priority").sort(byRecent);
  const picked = [], seen = new Set();
  let used = 0;
  const take = (list, cap) => {
    const rest = [];
    for (const item of list) {
      const text = promptText(item.entry);
      const key = clean(text);
      const cost = estimateTokens(text) + 4;
      if (!key || seen.has(key) || used + cost > cap) { rest.push(item); continue; }
      picked.push({ entry: item.entry, text, tokens: cost });
      seen.add(key); used += cost;
    }
    return rest;
  };
  const waiting = take(priority, budget * 0.5);
  take(relevant, budget);
  take(waiting, budget);
  return picked;
}

/** 注入宿主的整段文字；宿主给每条 setContext 上限 4000 字符。 */
export function contextText(picked, maxChars = 3900) {
  const lines = [];
  let size = 0;
  for (const item of picked) {
    const line = "· " + item.text;
    if (size + line.length + 1 > maxChars) continue;
    lines.push(line); size += line.length + 1;
  }
  return lines.join("\n");
}
