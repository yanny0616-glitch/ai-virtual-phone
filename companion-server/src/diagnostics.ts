// 诊断：每个角色最近的聊天镜像 + 后端收到的快照时间。不输出任何密钥。

import type { Store, SnapshotInfo } from "./store.ts";
import { restJson, type MirrorRow, type Rest } from "./supabase.ts";

export type CharacterDiagnostics = {
  characterId: string;
  mirrorLatestAt: string | null;
  recent: { role: string; at: string; text: string }[];
  snapshot: SnapshotInfo | null;
};

export async function collectDiagnostics(rest: Rest, store: Store, userId: string, recentLimit = 20): Promise<{
  userId: string; characters: CharacterDiagnostics[]; generatedAt: string;
}> {
  const scope = `user_id=eq.${encodeURIComponent(userId)}`;
  // 用最近 500 条镜像找出活跃角色，再逐个取最近 N 条
  const latest = await restJson<Pick<MirrorRow, "character_id" | "message_at">[]>(
    rest, `push_chat_mirror?${scope}&select=character_id,message_at&order=message_at.desc&limit=500`,
  );
  const latestByCharacter = new Map<string, string>();
  for (const row of latest) if (row.character_id && !latestByCharacter.has(row.character_id)) latestByCharacter.set(row.character_id, row.message_at);

  const snapshots = new Map(store.listSnapshots().map(s => [s.characterId, s]));
  const ids = [...new Set([...latestByCharacter.keys(), ...snapshots.keys()])];

  const characters = await Promise.all(ids.map(async characterId => {
    const rows = await restJson<MirrorRow[]>(
      rest,
      `push_chat_mirror?${scope}&character_id=eq.${encodeURIComponent(characterId)}`
        + `&select=id,role,content,media_type,message_at&order=message_at.desc&limit=${recentLimit}`,
    );
    return {
      characterId,
      mirrorLatestAt: latestByCharacter.get(characterId) ?? null,
      recent: rows.reverse().map(row => ({ role: row.role, at: row.message_at, text: row.content.slice(0, 80) })),
      snapshot: snapshots.get(characterId) ?? null,
    };
  }));
  return { userId, characters, generatedAt: new Date().toISOString() };
}
