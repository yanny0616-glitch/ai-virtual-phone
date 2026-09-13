import type { McpServerConfig } from "./settings-types";
import { XHS_MCP_TOOLS } from "./xhs-mcp-tools";

export const XHS_MCP_ID = "float-xiaohongshu";
export function isXhsMcpServer(server: McpServerConfig): boolean {
    return server.id === XHS_MCP_ID || server.discoveredTools?.some(tool => tool.name === "read_xiaohongshu_note") === true;
}

/** One visible toolbox entry; migrate the previously delivered local config. */
export function reconcileXhsMcpServers(servers: McpServerConfig[], origin: string): McpServerConfig[] {
    const existing = servers.find(isXhsMcpServer);
    const url = `${origin}/api/xhs-mcp`;
    const local = !existing || existing.url === url || existing.url === "/api/xhs-mcp";
    const server: McpServerConfig = existing ? {
        ...existing,
        ...(local ? { url, directFetch: true, discoveredTools: XHS_MCP_TOOLS } : {}),
    } : {
        id: XHS_MCP_ID, name: "小红书 MCP", url, enabled: true, directFetch: true,
        description: "统一用于自动读卡片、角色搜索、读正文、按需分批读评论和分享。搜索需要小红书登录，公开链接读取不需要。",
        discoveredTools: XHS_MCP_TOOLS, createdAt: Date.now(), updatedAt: Date.now(),
    };
    return [...servers.filter(item => !isXhsMcpServer(item)), server];
}
