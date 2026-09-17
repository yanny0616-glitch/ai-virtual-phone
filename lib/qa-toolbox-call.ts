import { getQaAuthorizedTools, type QaToolKind } from "./qa-tool-access";
import { getQaPageChars } from "./qa-prefs";
import { loadRestTools } from "./tool-storage";

export async function runQaToolboxCall(args: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<string> {
    const tools = getQaAuthorizedTools();
    if (args.action === "list") {
        return JSON.stringify({ tools: tools.map((tool) => ({ key: tool.key, kind: tool.kind, name: tool.name, description: tool.description, app: tool.appName })) });
    }
    const tool = tools.find((item) => item.key === args.tool_key);
    if (!tool) throw new Error("该工具未获工坊授权、在聊天工具箱里已关闭，或配置已变更。请用户在工坊配置中重新勾选。");
    if (args.action === "read") {
        let schema: unknown = tool.parameterSchema;
        try { schema = JSON.parse(tool.parameterSchema); } catch { /* 原样返回 */ }
        return JSON.stringify({ key: tool.key, kind: tool.kind, name: tool.name, description: tool.description, parameterSchema: schema });
    }
    if (args.action !== "call") throw new Error("action需为list、read或call");
    if (args.arguments !== undefined && (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments))) throw new Error("arguments必须是对象");
    const { executeWorkshopToolboxTool } = await import("./tool-executor");
    context?.signal?.throwIfAborted();
    // 执行前再查一次：配置可能在本轮中途被改
    const current = getQaAuthorizedTools().find((item) => item.key === tool.key);
    if (!current) throw new Error("该工具授权已撤回，未执行调用");
    const result = await executeWorkshopToolboxTool(
        { kind: current.kind as QaToolKind, id: current.id, name: current.name },
        (args.arguments || {}) as Record<string, unknown>,
        { appId: "qa", signal: context?.signal },
    );
    context?.signal?.throwIfAborted();
    let text = result.success ? (result.data || result.userNotice || "工具已执行，没有返回文本。") : (result.error || result.userNotice || "工具执行失败");
    // REST 工具的 headers / fixedParams 里通常是密钥：不论成功失败都不能回显
    if (current.kind === "rest") {
        const rest = loadRestTools().find((item) => item.id === current.id);
        // 整个值和值里的每个词都遮：`Bearer xxx` 这种前缀形态，上游回显的往往只有 xxx
        const secrets = new Set<string>();
        for (const value of [...Object.values(rest?.headers || {}), ...Object.values(rest?.fixedParams || {})]) {
            if (typeof value !== "string") continue;
            if (value.length >= 6) secrets.add(value);
            for (const piece of value.split(/\s+/)) if (piece.length >= 8 && !/^(bearer|basic|token|apikey)$/i.test(piece)) secrets.add(piece);
        }
        for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[凭据已隐藏]");
    }
    if (!result.success) throw new Error(text.slice(0, 1000));
    const budget = getQaPageChars();
    return text.length > budget ? text.slice(0, budget) + "\n[结果超过工坊单页限制，已截断；请使用该工具的分页或筛选参数继续读取。]" : text;
}

export const QA_TOOLBOX_CALL_TOOL = {
    name: "调用工具箱工具", nativeName: "call_workshop_toolbox_tool",
    description: "调用用户在工坊配置中勾选、且在聊天工具箱已启用的 REST 工具、组合工具或自定义 APP 工具（MCP 走「调用MCP」）。先list列出可用工具，read读取参数schema，再call传arguments对象。调用有外部影响（发送、发布、删除、付款）的工具前必须得到用户明确授权；失败不要擅自重复执行。不能自行修改工坊授权范围。",
    schemaLines: ["[执行动作:调用工具箱工具({\"action\":\"list\"})]", "read/call需tool_key（list返回的key）；call的arguments为工具参数对象。"],
    parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "read", "call"] }, tool_key: { type: "string" }, arguments: { type: "object" } }, required: ["action"] },
    run: runQaToolboxCall,
};
