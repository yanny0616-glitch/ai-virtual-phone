import { kvGet, kvSet } from "./kv-db";
import { loadMcpServers } from "./tool-storage";
import type { McpServerConfig } from "./settings-types";
const KEY="ai_phone_qa_mcp_access";
export function loadQaMcpAccess(): Record<string,string> {
    try {const value=JSON.parse(kvGet(KEY)||"{}");return value && typeof value==="object" && !Array.isArray(value)?value:{};}catch{return {};}
}
export function saveQaMcpAccess(value:Record<string,string>):void {kvSet(KEY,JSON.stringify(value));}
export function getQaMcpServers():McpServerConfig[] {
    const access=loadQaMcpAccess();
    return loadMcpServers().filter(server=>server.enabled && access[server.id]===server.url);
}
