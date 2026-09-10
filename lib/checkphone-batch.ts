"use client";

// 查手机批量生成：桌面上一次勾选多个 APP，按顺序调用各自的生成函数并落盘。
// 走 refresh-tracker 的 begin/end，正开着的 APP 页会看到转圈并在完成后自动刷新。

import type { CheckPhoneAppId, CheckPhoneSnapshot } from "./checkphone-config";
import {
  generateCheckPhoneAssets,
  generateCheckPhoneBilibili,
  generateCheckPhoneBrowser,
  generateCheckPhoneChat,
  generateCheckPhoneDouban,
  generateCheckPhoneDouyin,
  generateCheckPhoneEmail,
  generateCheckPhoneInstagram,
  generateCheckPhoneMessages,
  generateCheckPhoneMusic,
  generateCheckPhoneNotes,
  generateCheckPhonePhone,
  generateCheckPhonePhotos,
  generateCheckPhoneReading,
  generateCheckPhoneReddit,
  generateCheckPhoneShopping,
  generateCheckPhoneSteam,
  generateCheckPhoneTakeout,
  generateCheckPhoneTelegram,
  generateCheckPhoneWeibo,
  generateCheckPhoneX,
  generateCheckPhoneXiaohongshu,
  generateCheckPhoneYoutube,
} from "./checkphone-engine";
import { beginCheckPhoneRefresh, endCheckPhoneRefresh, isCheckPhoneRefreshing } from "./checkphone-refresh-tracker";
import { loadPhoneSnapshot, savePhoneSnapshot } from "./checkphone-storage";

type Generator = (
  characterId: string,
  previousPayload?: never,
  previousUpdatedAt?: string,
) => Promise<{ payload: unknown; summary: string; error?: string }>;

const GENERATORS: Record<CheckPhoneAppId, Generator> = {
  phone: generateCheckPhonePhone as Generator,
  messages: generateCheckPhoneMessages as Generator,
  browser: generateCheckPhoneBrowser as Generator,
  photos: generateCheckPhonePhotos as Generator,
  chat: generateCheckPhoneChat as Generator,
  shopping: generateCheckPhoneShopping as Generator,
  assets: generateCheckPhoneAssets as Generator,
  notes: generateCheckPhoneNotes as Generator,
  reading: generateCheckPhoneReading as Generator,
  xiaohongshu: generateCheckPhoneXiaohongshu as Generator,
  takeout: generateCheckPhoneTakeout as Generator,
  weibo: generateCheckPhoneWeibo as Generator,
  douyin: generateCheckPhoneDouyin as Generator,
  email: generateCheckPhoneEmail as Generator,
  music: generateCheckPhoneMusic as Generator,
  x: generateCheckPhoneX as Generator,
  reddit: generateCheckPhoneReddit as Generator,
  youtube: generateCheckPhoneYoutube as Generator,
  bilibili: generateCheckPhoneBilibili as Generator,
  instagram: generateCheckPhoneInstagram as Generator,
  telegram: generateCheckPhoneTelegram as Generator,
  steam: generateCheckPhoneSteam as Generator,
  douban: generateCheckPhoneDouban as Generator,
};

export type CheckPhoneBatchItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type CheckPhoneBatchProgress = {
  appId: CheckPhoneAppId;
  status: CheckPhoneBatchItemStatus;
  error?: string;
};

/** 生成一个 APP 的快照并落盘；已在生成中的跳过 */
export async function generateCheckPhoneAppSnapshot(
  characterId: string,
  appId: CheckPhoneAppId,
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const key = `${characterId}:${appId}`;
  if (isCheckPhoneRefreshing(key)) return { ok: false, skipped: true };
  beginCheckPhoneRefresh(key);
  try {
    const previous = await loadPhoneSnapshot(characterId, appId);
    const { payload, summary, error } = await GENERATORS[appId](
      characterId,
      (previous?.payload ?? null) as never,
      previous?.updatedAt,
    );
    if (!payload) return { ok: false, error: error || "生成失败" };
    const now = new Date().toISOString();
    const snapshot: CheckPhoneSnapshot = {
      id: key,
      characterId,
      appId,
      generatedAt: previous?.generatedAt ?? now,
      updatedAt: now,
      summary,
      payload,
    };
    await savePhoneSnapshot(snapshot);
    return { ok: true, error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    endCheckPhoneRefresh(key);
  }
}

/** 并发 2 个：够快，又不至于把中转打到限流 */
const BATCH_CONCURRENCY = 2;

export async function runCheckPhoneBatch(
  characterId: string,
  appIds: CheckPhoneAppId[],
  onProgress: (progress: CheckPhoneBatchProgress) => void,
  signal?: { cancelled: boolean },
): Promise<void> {
  const queue = [...appIds];
  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.cancelled) return;
      const appId = queue.shift()!;
      onProgress({ appId, status: "running" });
      const result = await generateCheckPhoneAppSnapshot(characterId, appId);
      onProgress({
        appId,
        status: result.skipped ? "skipped" : result.ok ? "done" : "failed",
        error: result.ok ? undefined : result.error,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
}

/** 哪些 APP 已有快照（用来默认勾选「未生成」） */
export async function loadCheckPhoneGeneratedSet(characterId: string, appIds: CheckPhoneAppId[]): Promise<Set<CheckPhoneAppId>> {
  const generated = new Set<CheckPhoneAppId>();
  await Promise.all(appIds.map(async appId => {
    if (await loadPhoneSnapshot(characterId, appId)) generated.add(appId);
  }));
  return generated;
}
