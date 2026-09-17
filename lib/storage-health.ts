// 数据库写入失败收集：每个 Dexie 库都挂这个 addon（库文件顶部 import 本模块即可）。
// 只记本次打开页面以来的失败，重试就是把记下的值再写一遍——关掉页面这些就没了，文案不能说「会补回」。
import Dexie, { type DBCore, type DBCoreMutateRequest, type DBCoreMutateResponse, type IndexableTypeArrayReadonly, type Middleware } from "dexie";

type FailedWrite = {
    id: number;
    db: Dexie;
    table: string;
    kind: DBCoreMutateRequest["type"];
    values?: readonly unknown[];
    keys?: IndexableTypeArrayReadonly;
    label: string;
    preview: string;
    messageIds: string[];
    at: number;
    error: string;
};

export type StorageFailure = Pick<FailedWrite, "id" | "label" | "preview" | "at" | "error"> & { retryable: boolean };

export type StorageHealthSnapshot = {
    failures: readonly StorageFailure[];
    unsavedMessageIds: readonly string[];
    connectionLost: boolean;
    /** 连续几次重试后仍有失败 */
    failedRetries: number;
    /** 超出上限、只计数不留值的失败 */
    overflow: number;
    usage: number | null;
    quota: number | null;
};

const MAX_KEPT = 80;
const DB_LABELS: Record<string, string> = {
    AiPhoneChatDB: "聊天记录",
    AiPhoneKvDB: "设置和小数据",
    AiPhoneSettingsDB: "设置",
    AiPhoneMomentsDB: "朋友圈",
    AiPhoneMediaCacheDB: "图片缓存",
    AiPhoneDwellingDB: "住所",
    AiPhoneMapDB: "地图",
    AiPhoneCheckPhoneDB: "查手机",
    AiPhoneStoryDB: "剧情",
    AiPhoneVnDB: "视觉小说",
    "reading-db": "阅读",
};
const TABLE_LABELS: Record<string, string> = {
    "AiPhoneChatDB/messages": "聊天消息",
    "AiPhoneChatDB/sessions": "会话",
    "AiPhoneChatDB/contacts": "联系人",
};

let failed: FailedWrite[] = [];
let overflow = 0;
let nextId = 1;
let connectionLost = false;
let failedRetries = 0;
let replaying = 0;
let usage: number | null = null;
let quota: number | null = null;
const knownDbs = new Set<Dexie>();
const listeners = new Set<() => void>();
const pendingByTrans = new WeakMap<object, Array<{ rec: FailedWrite; done: boolean }>>();

const EMPTY: StorageHealthSnapshot = { failures: [], unsavedMessageIds: [], connectionLost: false, failedRetries: 0, overflow: 0, usage: null, quota: null };
let snapshot: StorageHealthSnapshot = EMPTY;

function emit(): void {
    snapshot = {
        failures: failed.map(f => ({ id: f.id, label: f.label, preview: f.preview, at: f.at, error: f.error, retryable: f.kind !== "deleteRange" })),
        unsavedMessageIds: failed.flatMap(f => f.messageIds),
        connectionLost,
        failedRetries,
        overflow,
        usage,
        quota,
    };
    for (const fn of listeners) fn();
}

export function subscribeStorageHealth(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getStorageHealth(): StorageHealthSnapshot {
    return snapshot;
}

export function getServerStorageHealth(): StorageHealthSnapshot {
    return EMPTY;
}

function errorName(err: unknown): string {
    return err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
}

// ConstraintError 是业务层的「主键已存在」之类；AbortError 多半是连带失败，真正原因会在事务 abort 时拿到。
// 库被代码主动关掉（恢复备份时删库）也会报 DatabaseClosedError，只有浏览器断开连接之后才算。
function isRealFailure(err: unknown): boolean {
    const name = errorName(err);
    if (!name) return false;
    if (name === "ConstraintError" || name === "AbortError") return false;
    if (name === "DatabaseClosedError") return connectionLost;
    return true;
}

function describe(err: unknown): string {
    const name = errorName(err);
    if (name === "QuotaExceededError") return "存储空间满了";
    if (name === "DataCloneError") return "内容里有存不下的东西";
    if (name === "DatabaseClosedError" || name === "InvalidStateError" || name === "UnknownError") return "数据库连接断了";
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return (name ? `${name}：` : "") + msg.slice(0, 80);
}

function buildRecord(db: Dexie, table: string, req: DBCoreMutateRequest): FailedWrite {
    const values = req.type === "add" || req.type === "put" ? req.values : undefined;
    const isMessages = db.name === "AiPhoneChatDB" && table === "messages";
    const first = values?.[0] as { content?: unknown } | undefined;
    const preview = isMessages && typeof first?.content === "string" ? first.content.replace(/\s+/g, " ").trim().slice(0, 24) : "";
    return {
        id: 0,
        db,
        table,
        kind: req.type,
        values,
        keys: req.type === "deleteRange" ? undefined : req.keys,
        label: TABLE_LABELS[`${db.name}/${table}`] ?? DB_LABELS[db.name] ?? db.name,
        preview,
        messageIds: isMessages && values
            ? values.map(v => (v as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
            : [],
        at: Date.now(),
        error: "",
    };
}

function addFailure(rec: FailedWrite, err: unknown): void {
    rec.id = nextId++;
    rec.error = describe(err);
    if (errorName(err) === "QuotaExceededError") void refreshStorageEstimate();
    failed.push(rec);
    while (failed.length > MAX_KEPT) {
        failed.shift();
        overflow += 1;
    }
    emit();
}

function track(rec: FailedWrite, trans: object): { rec: FailedWrite; done: boolean } {
    let list = pendingByTrans.get(trans);
    if (!list) {
        const fresh: Array<{ rec: FailedWrite; done: boolean }> = [];
        list = fresh;
        pendingByTrans.set(trans, fresh);
        const idb = trans as Partial<IDBTransaction>;
        if (typeof idb.addEventListener === "function") {
            idb.addEventListener("complete", () => pendingByTrans.delete(trans));
            idb.addEventListener("abort", () => {
                pendingByTrans.delete(trans);
                const err = idb.error;
                if (!isRealFailure(err)) return;
                for (const op of fresh) {
                    if (op.done) continue;
                    op.done = true;
                    addFailure(op.rec, err);
                }
            });
        }
    }
    const op = { rec, done: false };
    list.push(op);
    return op;
}

function onPartialFailure(op: { rec: FailedWrite; done: boolean }, res: DBCoreMutateResponse): void {
    const errors = Object.entries(res.failures).filter(([, e]) => isRealFailure(e));
    if (!errors.length) return;
    const idx = new Set(errors.map(([i]) => Number(i)));
    const rec = op.rec;
    if (rec.values) rec.values = rec.values.filter((_, i) => idx.has(i));
    if (rec.keys) rec.keys = rec.keys.filter((_, i) => idx.has(i));
    if (rec.messageIds.length) rec.messageIds = rec.messageIds.filter((_, i) => idx.has(i));
    op.done = true;
    addFailure(rec, errors[0][1]);
}

function storageHealthMiddleware(db: Dexie): Middleware<DBCore> {
    return {
        stack: "dbcore",
        name: "storage-health",
        create(down) {
            return {
                ...down,
                table(tableName) {
                    const table = down.table(tableName);
                    return {
                        ...table,
                        mutate(req) {
                            const op = replaying ? null : track(buildRecord(db, tableName, req), req.trans);
                            return table.mutate(req).then(res => {
                                if (op && res.numFailures > 0) onPartialFailure(op, res);
                                return res;
                            }, err => {
                                if (op && !op.done && isRealFailure(err)) {
                                    op.done = true;
                                    addFailure(op.rec, err);
                                }
                                throw err;
                            });
                        },
                    };
                },
            };
        },
    };
}

function storageHealthAddon(db: Dexie): void {
    knownDbs.add(db);
    db.use(storageHealthMiddleware(db));
    // 只有浏览器强行断开连接才会触发（iPhone 切后台久了常见），代码里 db.close() 不触发。
    db.on("close", () => {
        connectionLost = true;
        emit();
    });
}

const ADDON_FLAG = "__floatStorageHealthAddon";
const globalFlags = globalThis as unknown as Record<string, boolean | undefined>;
if (!globalFlags[ADDON_FLAG]) {
    globalFlags[ADDON_FLAG] = true;
    Dexie.addons.push(storageHealthAddon);
}

async function reopen(db: Dexie): Promise<void> {
    db.close();
    await db.open();
}

async function replay(rec: FailedWrite): Promise<void> {
    const table = rec.db.table(rec.table);
    if (rec.kind === "delete") {
        await table.bulkDelete([...(rec.keys ?? [])]);
        return;
    }
    const values = [...(rec.values ?? [])];
    const outbound = !table.schema.primKey.keyPath;
    if (outbound && rec.keys?.length) await table.bulkPut(values, rec.keys);
    else await table.bulkPut(values);
}

/** 把记下的失败按原顺序再写一遍。返回还没存上的条数。 */
export async function retryFailedWrites(): Promise<number> {
    const batch = failed;
    failed = [];
    replaying += 1;
    try {
        if (connectionLost) {
            for (const db of knownDbs) {
                try { await reopen(db); } catch { /* 下面逐条再试 */ }
            }
            connectionLost = false;
        }
        const left: FailedWrite[] = [];
        for (const rec of batch) {
            if (rec.kind === "deleteRange") { left.push(rec); continue; }
            try {
                if (!rec.db.isOpen()) await rec.db.open();
                await replay(rec);
            } catch {
                try {
                    await reopen(rec.db);
                    await replay(rec);
                } catch (err) {
                    rec.error = describe(err);
                    left.push(rec);
                }
            }
        }
        failed = [...left, ...failed];
        failedRetries = failed.length ? failedRetries + 1 : 0;
        if (!failed.length) overflow = 0;
        return failed.length;
    } finally {
        replaying -= 1;
        emit();
    }
}

export async function refreshStorageEstimate(): Promise<void> {
    try {
        const est = await navigator.storage?.estimate?.();
        if (!est) return;
        usage = typeof est.usage === "number" ? est.usage : null;
        quota = typeof est.quota === "number" && est.quota > 0 ? est.quota : null;
        emit();
    } catch {
        /* Safari 旧版本没有 estimate */
    }
}

/** 没存上的聊天消息全文，给「复制文字」用 */
export function unsavedMessageTexts(): string[] {
    return failed
        .filter(f => f.messageIds.length)
        .flatMap(f => (f.values ?? []).map(v => (v as { content?: unknown })?.content))
        .filter((c): c is string => typeof c === "string" && c.trim() !== "");
}

/** 已用 / 配额；拿不到配额时为 null */
export function storageUsageRatio(s: Pick<StorageHealthSnapshot, "usage" | "quota">): number | null {
    return s.usage !== null && s.quota ? s.usage / s.quota : null;
}
