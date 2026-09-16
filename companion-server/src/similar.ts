// 代码兜底的「同一件事」判断：模型没把新念头归到已有事项时，按字面相似度再拦一次。
// 去掉人称、语气词和标点后取二字组，重合数 / 较短一方的组数。
// 用 09-09 ～ 09-18 的真实念头标定：真重复 0.36～0.55，不相关的最高 0.18，阈值取 0.3。

import type { CloudMessage } from "./history.ts";
import type { PlanItem, Thread } from "./types.ts";

export const SIMILAR_AT = 0.3;

function grams(text: string): Set<string> {
  const t = text.replace(/核对约定 \[[^\]]*\]：/, "").replace(/[\s\p{P}\p{S}a-zA-Z0-9]/gu, "").replace(/[她他你我的了吗呢吧啊着就也还很]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function textSimilarity(a: string, b: string): number {
  const A = grams(a), B = grams(b);
  if (Math.min(A.size, B.size) < 4) return 0;
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return n / Math.min(A.size, B.size);
}

const promiseText = (th: Thread) => String(th.text || "");

/** 和还没兑现的约定是同一件事：约定负责，普通念头不再单发 */
export function similarPromise(intent: string, threads: Thread[]): Thread | null {
  for (const th of threads) {
    if (th.kind !== "promise" || th.done || th.status === "completed" || th.status === "cancelled") continue;
    if (textSimilarity(intent, promiseText(th)) >= SIMILAR_AT) return th;
  }
  return null;
}

/**
 * 新念头和已有的是同一件事就拦：
 *   还在排队的普通念头、没兑现的约定 → 一律拦
 *   今天已经发出去的 → 发出之后你没说过话（没有新进展）才拦
 */
export function similarBlock(intent: string, items: PlanItem[], threads: Thread[], messages: CloudMessage[], self?: PlanItem): string {
  const th = similarPromise(intent, threads);
  if (th) return `和约定「${th.text}」是同一件事，交给约定`;
  for (const other of items) {
    if (other === self || !other.act || other.kind === "promise") continue;
    const text = other.intent || other.source || "";
    if (textSimilarity(intent, text) < SIMILAR_AT) continue;
    if (!other.generatedAt) return `和 ${other.time} 那条还没发的是同一件事`;
    const replied = messages.some(m => m.role === "user" && Date.parse(m.message_at) > Number(other.generatedAt));
    if (!replied) return `和 ${other.time} 发过的是同一件事，之后你还没说话`;
  }
  return "";
}
