// Base URL 纠错：用户框里的原文不动，发请求时按服务商的格式补齐。
// 只在「只填了域名」时补版本段——带路径的地址（Cloudflare 网关 /openai 之类）照原样用。

export type ApiUrlNote = { tone: "ok" | "bad"; text: string };

export type ApiUrlFix = {
    /** 补齐后的 Base URL（不带结尾斜杠）；空输入或格式不对时为空串 */
    base: string;
    /** 用来展示：前缀补的、保留的、剪掉的、补上的、拼在后面的 */
    parts: { scheme: string; kept: string; cut: string; add: string; tail: string; tailIsTemplate: boolean };
    notes: ApiUrlNote[];
    suggest?: { provider: string; text: string };
    empty?: boolean;
    invalid?: boolean;
};

type Wire = "anthropic" | "gemini" | "openai";

function wireFor(provider: string): Wire {
    if (provider === "Anthropic") return "anthropic";
    if (provider === "Google") return "gemini";
    return "openai";
}

export function fixApiBaseUrl(provider: string, raw: string | undefined): ApiUrlFix {
    const parts = { scheme: "", kept: "", cut: "", add: "", tail: "", tailIsTemplate: false };
    const notes: ApiUrlNote[] = [];
    let s = (raw || "").trim();
    if (!s) return { base: "", parts, notes, empty: true };
    if (!/^https?:\/\//i.test(s)) {
        parts.scheme = "https://";
        s = parts.scheme + s;
        notes.push({ tone: "ok", text: "补了 https://" });
    }
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return { base: "", parts, notes: [{ tone: "bad", text: "地址格式不对，检查有没有多余的空格或中文符号" }], invalid: true };
    }
    if (url.protocol === "http:" && !/^(localhost|127\.|\[::1\])/i.test(url.hostname)) {
        notes.push({ tone: "bad", text: "http:// 在网页里会被浏览器拦下，要换成 https://" });
    }
    const wire = wireFor(provider);
    let path = url.pathname.replace(/\/+$/, "");
    let suggest: ApiUrlFix["suggest"];
    if (/(^|\.)anthropic\.com$/i.test(url.hostname) && wire !== "anthropic") {
        suggest = { provider: "Anthropic", text: "这是 Claude 官方地址，服务商选 Anthropic 才能用官方格式" };
    } else if (/\/v1beta$/.test(path) && wire !== "gemini") {
        suggest = { provider: "Google", text: "以 /v1beta 结尾的是 Gemini 原生地址，服务商选 Google Gemini" };
    }

    const cut = (suffix: RegExp): void => {
        const m = path.match(suffix);
        if (!m) return;
        parts.cut = m[0];
        path = path.slice(0, -m[0].length);
        notes.push({ tone: "ok", text: `结尾的 ${m[0]} 去掉再拼` });
    };

    if (wire === "anthropic") {
        cut(/\/messages$/);
        if (!path) { parts.add = "/v1"; notes.push({ tone: "ok", text: "只填了域名，补了 /v1" }); }
        parts.tail = "/messages";
    } else if (wire === "gemini") {
        cut(/\/models$/);
        if (!path) { parts.add = "/v1beta"; notes.push({ tone: "ok", text: "只填了域名，补了 /v1beta" }); }
        parts.tail = "/models/…:generateContent";
        parts.tailIsTemplate = true;
    } else if (/\/chat\/completions$/.test(path)) {
        notes.push({ tone: "ok", text: "已经是完整地址，照原样用" });
    } else {
        cut(/\/(models|completions|embeddings)$/);
        if (!path) { parts.add = "/v1"; notes.push({ tone: "ok", text: "只填了域名，补了 /v1" }); }
        parts.tail = "/chat/completions";
    }
    parts.kept = (url.origin + path).slice(parts.scheme.length) + url.search;
    return { base: url.origin + path + parts.add + url.search, parts, notes, suggest };
}

/** 发请求用：纠不了（格式不对）就原样返回，让后面的报错照常出来。 */
export function correctApiBaseUrl(provider: string, raw: string): string {
    const fixed = fixApiBaseUrl(provider, raw);
    return fixed.base || raw.trim();
}
