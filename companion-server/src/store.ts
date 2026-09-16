// 后端自己的数据：SQLite 单文件。阶段 1 只存提示词快照（每个角色一份最新的）。
// 快照里带模型地址和密钥，文件与目录权限由 main 收紧到 0600/0700。

import { DatabaseSync } from "node:sqlite";

export type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

export type Snapshot = {
  characterId: string;
  sessionId: string;
  /** 快照包含的最后一条聊天，醒来时据此从聊天镜像补齐之后的消息 */
  lastMessageId: string;
  lastMessageAt: string;
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  /** 手机导入 push_outbox 时需要的显示字段 */
  reply: { regexes?: unknown[]; characterName?: string; userName?: string; appId?: string; appTags?: string[] };
};

export type SnapshotInfo = { characterId: string; sessionId: string; lastMessageAt: string; receivedAt: string; bytes: number };

const PROVIDERS = new Set<ProviderKind>(["openai-compatible", "anthropic", "gemini"]);

/** 校验手机传来的快照；返回错误原因或 null。 */
export function validateSnapshot(value: unknown): string | null {
  const s = value as Partial<Snapshot> | null;
  if (!s || typeof s !== "object") return "快照不是对象";
  for (const key of ["characterId", "sessionId", "lastMessageId", "lastMessageAt"] as const) {
    if (typeof s[key] !== "string" || !s[key]) return `缺少 ${key}`;
  }
  if (Number.isNaN(Date.parse(s.lastMessageAt!))) return "lastMessageAt 不是有效时间";
  const r = s.request;
  if (!r || typeof r !== "object") return "缺少 request";
  if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) return "request.url 无效";
  if (!r.headers || typeof r.headers !== "object") return "request.headers 无效";
  if (!r.body || typeof r.body !== "object") return "request.body 无效";
  if (!PROVIDERS.has(r.providerKind as ProviderKind)) return "request.providerKind 无效";
  if (!s.reply || typeof s.reply !== "object") return "缺少 reply";
  return null;
}

export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      pragma journal_mode = wal;
      create table if not exists snapshots (
        character_id text primary key,
        session_id text not null,
        last_message_at text not null,
        payload text not null,
        received_at text not null
      );
    `);
  }

  saveSnapshot(snapshot: Snapshot, now = new Date()): void {
    this.#db.prepare(`
      insert into snapshots (character_id, session_id, last_message_at, payload, received_at)
      values (?, ?, ?, ?, ?)
      on conflict(character_id) do update set
        session_id = excluded.session_id, last_message_at = excluded.last_message_at,
        payload = excluded.payload, received_at = excluded.received_at
    `).run(snapshot.characterId, snapshot.sessionId, snapshot.lastMessageAt, JSON.stringify(snapshot), now.toISOString());
  }

  getSnapshot(characterId: string): Snapshot | null {
    const row = this.#db.prepare("select payload from snapshots where character_id = ?").get(characterId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Snapshot : null;
  }

  /** 诊断用：不含请求内容（里面有密钥）。 */
  listSnapshots(): SnapshotInfo[] {
    const rows = this.#db.prepare(
      "select character_id, session_id, last_message_at, received_at, length(payload) as bytes from snapshots order by received_at desc",
    ).all() as { character_id: string; session_id: string; last_message_at: string; received_at: string; bytes: number }[];
    return rows.map(row => ({
      characterId: row.character_id, sessionId: row.session_id,
      lastMessageAt: row.last_message_at, receivedAt: row.received_at, bytes: row.bytes,
    }));
  }

  close(): void { this.#db.close(); }
}
