// 语境属性：把界面当下的状态挂成 DOM 属性和 CSS 变量，主题 CSS 用属性选择器就能写
// 「未读堆了很多就烧起来」「入夜换配色」这类规则，不用改组件。
// 属性名一经发布就不再改名，清单见 lib/theme-types.ts 顶部注释。
import { useEffect, useState } from "react";
import { bgSetInterval } from "./bg-timer";
import type { ChatMessage } from "./chat-storage";

export type TimeOfDay = "morning" | "day" | "evening" | "night";
export type ColorScheme = "light" | "dark";

export function timeOfDayForHour(hour: number): TimeOfDay {
    if (hour >= 5 && hour <= 10) return "morning";
    if (hour >= 11 && hour <= 16) return "day";
    if (hour >= 17 && hour <= 20) return "evening";
    return "night";
}

export type AmbientContext = { timeOfDay: TimeOfDay; hour: number; colorScheme: ColorScheme };

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readAmbient(): AmbientContext {
    const hour = new Date().getHours();
    const dark = typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia(DARK_QUERY).matches;
    return { timeOfDay: timeOfDayForHour(hour), hour, colorScheme: dark ? "dark" : "light" };
}

/** 服务端渲染阶段返回 null（没有属性），挂载后才写属性，避免注水前后对不上。 */
export function useAmbientContext(): AmbientContext | null {
    const [ambient, setAmbient] = useState<AmbientContext | null>(null);
    useEffect(() => {
        const sync = () => setAmbient(prev => {
            const next = readAmbient();
            return prev && prev.hour === next.hour && prev.colorScheme === next.colorScheme ? prev : next;
        });
        sync();
        // 整点跨档最迟一分钟内生效；切后台时浏览器会掐掉普通定时器，所以走 worker 心跳。
        const stop = bgSetInterval(sync, 60000);
        const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
        media?.addEventListener?.("change", sync);
        document.addEventListener("visibilitychange", sync);
        return () => {
            stop();
            media?.removeEventListener?.("change", sync);
            document.removeEventListener("visibilitychange", sync);
        };
    }, []);
    return ambient;
}

export function ambientAttrs(ambient: AmbientContext | null): Record<string, string> {
    if (!ambient) return {};
    return {
        "data-time-of-day": ambient.timeOfDay,
        "data-hour": String(ambient.hour),
        "data-color-scheme": ambient.colorScheme,
    };
}

/** 某个时间点落在哪一档；时间解析不出来就不挂属性。 */
export function timeSlotAttrs(iso?: string | null): Record<string, string> {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return {};
    const hour = new Date(ms).getHours();
    return { "data-hour": String(hour), "data-time-slot": timeOfDayForHour(hour) };
}

export function unreadBucket(unread: number): "0" | "1" | "few" | "many" {
    if (!(unread > 0)) return "0";
    if (unread === 1) return "1";
    return unread < 10 ? "few" : "many";
}

export function textLengthBucket(text: string): "short" | "medium" | "long" {
    const length = text.trim().length;
    if (length <= 8) return "short";
    return length <= 24 ? "medium" : "long";
}

/** data-last-type 直接用消息的 mediaType，纯文字为 text，下划线换成连字符方便写选择器。 */
export function lastMessageType(message?: Pick<ChatMessage, "mediaType"> | null): string {
    return message?.mediaType ? message.mediaType.replace(/_/g, "-") : "text";
}

export type SessionItemContext = {
    index: number;
    unread: number;
    pinned: boolean;
    muted: boolean;
    group: boolean;
    preview: string;
    lastMessage?: Pick<ChatMessage, "mediaType" | "role"> | null;
    lastTime?: string | null;
    avatarUrl?: string | null;
};

export function sessionItemAttrs(context: SessionItemContext): Record<string, string> {
    return {
        "data-unread": unreadBucket(context.unread),
        "data-unread-count": String(Math.max(0, context.unread)),
        "data-pinned": context.pinned ? "1" : "0",
        "data-muted": context.muted ? "1" : "0",
        "data-group": context.group ? "1" : "0",
        "data-last-type": lastMessageType(context.lastMessage),
        ...(context.lastMessage?.role ? { "data-last-role": context.lastMessage.role } : {}),
        "data-length": textLengthBucket(context.preview),
        ...timeSlotAttrs(context.lastTime),
    };
}

// base64 头像动辄几百 KB，塞进每一行的 style 会把 DOM 撑大，只给短地址（blob:/http/asset）挂变量。
const AVATAR_URL_MAX = 512;

export function sessionItemVars(context: SessionItemContext): Record<string, string | number> {
    const avatar = context.avatarUrl && context.avatarUrl.length <= AVATAR_URL_MAX ? context.avatarUrl : "";
    return {
        "--item-index": context.index,
        "--item-unread": Math.max(0, context.unread),
        ...(avatar ? { "--item-avatar-url": `url("${avatar.replace(/"/g, '\\"')}")` } : {}),
    };
}
