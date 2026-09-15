// 用户看的更新日志：public/changelog.json 随版本发布，已读位置存 kv。
// id 是可排序的日期串（2026-09-15、同一天多次加 a/b/c），按字符串比较新旧。
import { kvGet, kvSet } from "./kv-db";

export type ChangelogKind = "new" | "opt" | "fix";
export type ChangelogItem = { area: string; kind: ChangelogKind; text: string };
export type ChangelogEntry = { id: string; date: string; items: ChangelogItem[] };

const SEEN_KEY = "changelog-seen-v1";
const KINDS = new Set<ChangelogKind>(["new", "opt", "fix"]);

export function normalizeChangelog(raw: unknown): ChangelogEntry[] {
    const list = raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
        ? (raw as { entries: unknown[] }).entries
        : [];
    const out: ChangelogEntry[] = [];
    for (const e of list) {
        const entry = e as Partial<ChangelogEntry>;
        if (typeof entry?.id !== "string" || !Array.isArray(entry.items)) continue;
        const items = entry.items.filter((it): it is ChangelogItem =>
            !!it && typeof it.text === "string" && typeof it.area === "string" && KINDS.has(it.kind as ChangelogKind));
        if (items.length) out.push({ id: entry.id, date: typeof entry.date === "string" ? entry.date : entry.id.slice(0, 10), items });
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function fetchLocalChangelog(): Promise<ChangelogEntry[]> {
    try {
        const res = await fetch("/changelog.json", { cache: "no-store" });
        if (!res.ok) return [];
        return normalizeChangelog(await res.json());
    } catch {
        return [];
    }
}

export function loadSeenChangelogId(): string | null {
    return kvGet(SEEN_KEY);
}

export function markChangelogSeen(id: string): void {
    kvSet(SEEN_KEY, id);
}

export function changelogAfter(entries: ChangelogEntry[], id: string | null): ChangelogEntry[] {
    return id === null ? entries : entries.filter(e => e.id > id);
}

export function formatChangelogDate(date: string): string {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
    return m ? `${Number(m[1])}月${Number(m[2])}日` : date;
}
