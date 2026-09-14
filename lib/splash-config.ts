// 开屏动画选择与自定义开屏。存 localStorage 而不是 KV：开屏在 KV 水合之前就渲染，KV 那时还读不到。
// 两个键都登记进「桌面与主题」备份模块，备份/迁移会带走。

export const SPLASH_VARIANT_KEY = "ai_phone_splash_variant";
export const SPLASH_CUSTOM_KEY = "ai_phone_splash_custom_v1";

export type BuiltinSplashId = "float" | "ink" | "aurora" | "pulse" | "none";
export type SplashVariantId = BuiltinSplashId | `custom:${string}`;

export const SPLASH_VARIANTS: Array<{ id: BuiltinSplashId; label: string; desc: string }> = [
    { id: "float", label: "漂浮", desc: "默认。对话气泡化作字母升起，克莱因蓝" },
    { id: "ink", label: "墨色", desc: "深底，衬线字从雾里浮出，一点呼吸的光" },
    { id: "aurora", label: "极光", desc: "几团色光在纸面上慢慢流动" },
    { id: "pulse", label: "脉冲", desc: "点阵与同心圆一圈圈荡开，等宽字逐字敲出" },
    { id: "none", label: "不要开屏", desc: "加载完成后直接进桌面" },
];

const BUILTIN_IDS = new Set<string>(SPLASH_VARIANTS.map((v) => v.id));

// ── 自定义开屏：一段完整 HTML（可带 <style>/<script>），在沙盒 iframe 里独立运行 ──
export type CustomSplash = {
    id: string;
    name: string;
    code: string;
    createdAt: number;
    updatedAt: number;
};

export const CUSTOM_SPLASH_MAX = 20;
export const CUSTOM_SPLASH_MAX_CODE_CHARS = 400_000;

export function loadCustomSplashes(): CustomSplash[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(SPLASH_CUSTOM_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is CustomSplash =>
            Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" && typeof item.code === "string",
        );
    } catch {
        return [];
    }
}

function persistCustomSplashes(list: CustomSplash[]): void {
    localStorage.setItem(SPLASH_CUSTOM_KEY, JSON.stringify(list));
}

/** 新建或更新（传 id 即更新）。抛错：超出数量/体积上限、localStorage 写满 */
export function saveCustomSplash(input: { id?: string; name: string; code: string }): CustomSplash {
    const code = input.code.trim();
    if (!code) throw new Error("代码不能为空。");
    if (code.length > CUSTOM_SPLASH_MAX_CODE_CHARS) throw new Error(`代码超过 ${Math.round(CUSTOM_SPLASH_MAX_CODE_CHARS / 1000)}K 字符上限，把内嵌的大图/字体拿掉再试。`);
    const list = loadCustomSplashes();
    const now = Date.now();
    const name = input.name.trim() || `自定义开屏 ${list.length + 1}`;
    const existing = input.id ? list.find((item) => item.id === input.id) : undefined;
    let next: CustomSplash;
    if (existing) {
        next = { ...existing, name, code, updatedAt: now };
        persistOrThrow(list.map((item) => (item.id === existing.id ? next : item)));
    } else {
        if (list.length >= CUSTOM_SPLASH_MAX) throw new Error(`最多保存 ${CUSTOM_SPLASH_MAX} 套自定义开屏，先删几套。`);
        next = { id: `cs_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name, code, createdAt: now, updatedAt: now };
        persistOrThrow([next, ...list]);
    }
    return next;
}

function persistOrThrow(list: CustomSplash[]): void {
    try {
        persistCustomSplashes(list);
    } catch {
        throw new Error("浏览器本地存储已满，存不下这套开屏。");
    }
}

export function deleteCustomSplash(id: string): void {
    persistCustomSplashes(loadCustomSplashes().filter((item) => item.id !== id));
    if (readSplashVariant() === `custom:${id}`) writeSplashVariant("float");
}

export function customSplashVariantId(id: string): SplashVariantId {
    return `custom:${id}`;
}

export function resolveCustomSplash(variant: SplashVariantId): CustomSplash | null {
    if (!variant.startsWith("custom:")) return null;
    const id = variant.slice("custom:".length);
    return loadCustomSplashes().find((item) => item.id === id) ?? null;
}

export function readSplashVariant(): SplashVariantId {
    try {
        const raw = localStorage.getItem(SPLASH_VARIANT_KEY);
        if (raw && BUILTIN_IDS.has(raw)) return raw as BuiltinSplashId;
        if (raw?.startsWith("custom:") && resolveCustomSplash(raw as SplashVariantId)) return raw as SplashVariantId;
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

/** 用户贴的可能只是片段：没有 <html> 就补一个最小文档壳，铺满、无边距 */
export function buildCustomSplashDocument(code: string): string {
    if (/<html[\s>]/i.test(code)) return code;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden;background:#F1F2F6}</style></head><body>${code}</body></html>`;
}
