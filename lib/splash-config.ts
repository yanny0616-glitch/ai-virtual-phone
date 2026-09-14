// 开屏动画选择。存 localStorage 而不是 KV：开屏在 KV 水合之前就渲染，KV 那时还读不到。
// 只是一个枚举值，不进备份也无妨（换设备重选一次）。

export const SPLASH_VARIANT_KEY = "ai_phone_splash_variant";

export type SplashVariantId = "float" | "ink" | "aurora" | "pulse" | "none";

export const SPLASH_VARIANTS: Array<{ id: SplashVariantId; label: string; desc: string }> = [
    { id: "float", label: "漂浮", desc: "默认。对话气泡化作字母升起，克莱因蓝" },
    { id: "ink", label: "墨色", desc: "深底，衬线字从雾里浮出，一点呼吸的光" },
    { id: "aurora", label: "极光", desc: "几团色光在纸面上慢慢流动" },
    { id: "pulse", label: "脉冲", desc: "点阵与同心圆一圈圈荡开，等宽字逐字敲出" },
    { id: "none", label: "不要开屏", desc: "加载完成后直接进桌面" },
];

const IDS = new Set<string>(SPLASH_VARIANTS.map((v) => v.id));

export function readSplashVariant(): SplashVariantId {
    try {
        const raw = localStorage.getItem(SPLASH_VARIANT_KEY);
        if (raw && IDS.has(raw)) return raw as SplashVariantId;
    } catch {
        // ignore
    }
    return "float";
}

export function writeSplashVariant(id: SplashVariantId): void {
    try {
        if (id === "float") localStorage.removeItem(SPLASH_VARIANT_KEY);
        else localStorage.setItem(SPLASH_VARIANT_KEY, id);
    } catch {
        // ignore
    }
}
