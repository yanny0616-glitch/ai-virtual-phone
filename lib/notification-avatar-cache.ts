// lib/notification-avatar-cache.ts
// 把角色头像缩成小图写进 Cache Storage，供 SW 弹推送通知时取用作 icon
// （sw.js 的 AVATAR_CACHE / AVATAR_PATH_PREFIX 与此对应）。
// 头像原图可能是几 MB 的 data URI，通知 icon 用不到也扛不动，统一缩到 192px。

import { loadCharacters } from "./character-storage";

const AVATAR_CACHE = "notif-avatar-v1";
const AVATAR_PATH_PREFIX = "/notif-avatar/";
const ICON_SIZE = 192;

async function shrinkToIconBlob(avatar: string): Promise<Blob | null> {
    const source = await fetch(avatar).then(r => (r.ok ? r.blob() : null)).catch(() => null);
    if (!source || !source.type.startsWith("image/")) return null;
    try {
        const bitmap = await createImageBitmap(source);
        const size = Math.min(ICON_SIZE, Math.max(bitmap.width, bitmap.height)) || ICON_SIZE;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        // 居中裁方：通知 icon 是方形展示位
        const crop = Math.min(bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, size, size);
        bitmap.close();
        return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    } catch {
        // createImageBitmap 不认的格式（少见 webp 变体等）：小于 200KB 就原样用
        return source.size < 200 * 1024 ? source : null;
    }
}

/**
 * 启动后调用一次：为每个有头像的角色写入/更新缩略图，清掉已删角色的残留。
 * 全程静默失败——这只是通知的锦上添花，绝不能影响启动。
 */
export async function syncNotificationAvatarCache(): Promise<void> {
    if (typeof window === "undefined" || !("caches" in window)) return;
    try {
        const cache = await caches.open(AVATAR_CACHE);
        const wanted = new Set<string>();
        for (const character of loadCharacters()) {
            const avatar = (character.avatar || "").trim();
            if (!avatar || !character.id) continue;
            const key = AVATAR_PATH_PREFIX + encodeURIComponent(character.id);
            wanted.add(new URL(key, window.location.origin).href);
            try {
                const blob = await shrinkToIconBlob(avatar);
                if (blob) await cache.put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg" } }));
            } catch { /* 单个头像失败不影响其余 */ }
        }
        for (const request of await cache.keys()) {
            if (!wanted.has(request.url)) await cache.delete(request);
        }
    } catch { /* 隐私模式等缓存不可用场景 */ }
}

/**
 * 回到前台时把托盘里的聊天类系统通知收掉（人已经在 App 里了，不用再挂着）。
 * 快捷指令/来电通知带有专属 type，不动。
 */
export function closeChatPushNotifications(): void {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration()
        .then(registration => registration?.getNotifications())
        .then(list => {
            for (const item of list || []) {
                const type = (item.data as { type?: string } | undefined)?.type || "";
                if (!type || type === "chat_outbox") item.close();
            }
        })
        .catch(() => undefined);
}
