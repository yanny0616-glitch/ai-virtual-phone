// 朋友圈个人主页的资料：签名走插件变量池（scope character 的 `profile`，签名插件和主页都读写同一份），
// 封面图是宿主自己的事，按角色存一张 IndexedDB 资产 id。
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { getChatPluginVar, setChatPluginVar } from "@/lib/chat-plugin-storage";

export const MOMENTS_PROFILE_VAR = "profile";
const COVERS_KEY = "moments_character_covers_v1";
registerKvMigration(COVERS_KEY);

export type MomentsProfile = {
    signature: string;
    /** 最后一次改签名的时间 */
    at: number;
    /** self=TA自己换的（签名插件截下来的），user=你在主页上改的 */
    by: "self" | "user";
};

export function readCharacterProfile(characterId: string): MomentsProfile | null {
    const raw = getChatPluginVar(MOMENTS_PROFILE_VAR, "character", characterId);
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const signature = String(rec.signature ?? "").trim();
    if (!signature) return null;
    return { signature, at: Number(rec.at) || 0, by: rec.by === "user" ? "user" : "self" };
}

export function writeCharacterSignature(characterId: string, signature: string, by: MomentsProfile["by"]): void {
    const current = getChatPluginVar(MOMENTS_PROFILE_VAR, "character", characterId);
    const base = current && typeof current === "object" ? current as Record<string, unknown> : {};
    setChatPluginVar(MOMENTS_PROFILE_VAR, { ...base, signature: signature.trim(), at: Date.now(), by }, "character", characterId);
}

function loadCovers(): Record<string, string> {
    try {
        const parsed = JSON.parse(kvGet(COVERS_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
}

export function readCharacterCoverAssetId(characterId: string): string | null {
    return loadCovers()[characterId] || null;
}

export function writeCharacterCoverAssetId(characterId: string, assetId: string): void {
    kvSet(COVERS_KEY, JSON.stringify({ ...loadCovers(), [characterId]: assetId }));
}
