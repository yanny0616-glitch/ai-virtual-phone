// 工坊可调用的工具箱工具（REST / 组合 / 自定义 APP 工具）授权表，与 MCP 授权（qa-mcp-access）同思路：
// 默认一个都不选；授权绑定「kind:id → 指纹」，指纹变了（REST 换了地址、组合工具被改过、APP 升了版）
// 授权立即失效，需用户重新勾选。调用还要求该工具在聊天工具箱里处于启用状态。
import { kvGet, kvSet } from "./kv-db";
import { loadRestTools, loadRestToolPackages, loadCompositeTools, loadCompositeToolPackages } from "./tool-storage";
import { loadCustomAppToolsForContext } from "./custom-app-sdk-registry";
import { loadInstalledCustomApps } from "./custom-app-storage";

const KEY = "ai_phone_qa_tool_access";

export type QaToolKind = "rest" | "composite" | "custom_app";

export type QaSelectableTool = {
    /** 授权表的键：`${kind}:${id}` */
    key: string;
    kind: QaToolKind;
    id: string;
    name: string;
    description: string;
    parameterSchema: string;
    /** 变了就让授权失效 */
    fingerprint: string;
    /** 聊天工具箱里是否启用（包内工具还要求包启用） */
    enabled: boolean;
    /** 自定义 APP 工具的来源 APP 名 */
    appName?: string;
};

export function loadQaToolAccess(): Record<string, string> {
    try {
        const value = JSON.parse(kvGet(KEY) || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

export function saveQaToolAccess(value: Record<string, string>): void {
    kvSet(KEY, JSON.stringify(value));
}

/** 所有可勾选的候选（含工具箱里已关闭的，UI 标注） */
export function listQaSelectableTools(): QaSelectableTool[] {
    const out: QaSelectableTool[] = [];
    const restPackages = loadRestToolPackages();
    const restPackageEnabled = new Map(restPackages.map((pkg) => [pkg.id, pkg.enabled]));
    for (const tool of loadRestTools()) {
        const packageState = tool.packageId ? restPackageEnabled.get(tool.packageId) : undefined;
        out.push({
            key: `rest:${tool.id}`, kind: "rest", id: tool.id, name: tool.name, description: tool.description,
            parameterSchema: tool.parameterSchema, fingerprint: `${tool.method} ${tool.endpoint}`,
            enabled: tool.enabled && packageState !== false,
        });
    }
    const compositePackages = loadCompositeToolPackages();
    const compositePackageEnabled = new Map(compositePackages.map((pkg) => [pkg.id, pkg.enabled]));
    for (const tool of loadCompositeTools()) {
        const packageState = tool.packageId ? compositePackageEnabled.get(tool.packageId) : undefined;
        out.push({
            key: `composite:${tool.id}`, kind: "composite", id: tool.id, name: tool.name, description: tool.description,
            parameterSchema: tool.parameterSchema, fingerprint: String(tool.updatedAt),
            enabled: tool.enabled && packageState !== false,
        });
    }
    const versions = new Map(loadInstalledCustomApps().map((app) => [app.id, String(app.manifest.version ?? "")]));
    for (const tool of loadCustomAppToolsForContext(undefined)) {
        out.push({
            key: `custom_app:${tool.appId}:${tool.id}`, kind: "custom_app", id: `${tool.appId}:${tool.id}`, name: tool.name,
            description: tool.description || `来自「${tool.appName}」的 APP 工具`,
            parameterSchema: JSON.stringify(tool.parameterSchema || { type: "object", properties: {} }),
            fingerprint: versions.get(tool.appId) ?? "", enabled: true, appName: tool.appName,
        });
    }
    return out;
}

/** 已授权且工具箱启用、指纹未变的工具：这才是工坊此刻能调的 */
export function getQaAuthorizedTools(): QaSelectableTool[] {
    const access = loadQaToolAccess();
    return listQaSelectableTools().filter((tool) => tool.enabled && access[tool.key] === tool.fingerprint);
}
