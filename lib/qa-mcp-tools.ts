import { getQaMcpServers } from "./qa-mcp-access";
import { getQaPageChars } from "./qa-prefs";

export async function runQaMcp(args:Record<string,unknown>,context?:{signal?:AbortSignal}):Promise<string> {
    const servers=getQaMcpServers();
    if(args.action==="list")return JSON.stringify({servers:servers.map(server=>({id:server.id,name:server.name,tools:(server.discoveredTools||[]).map(tool=>({name:tool.name,description:tool.description}))}))});
    const server=servers.find(server=>server.id===args.server_id);
    if(!server)throw new Error("该MCP未获工坊授权、已关闭或地址已改变。请用户在工坊配置中选择，并在聊天工具箱开启。");
    const tool=server.discoveredTools?.find(tool=>tool.name===args.tool_name);
    if(!tool)throw new Error("找不到该工具；先用配置聊天工具箱的discover更新工具列表，再list/read。");
    if(args.action==="read")return JSON.stringify({server_id:server.id,...tool});
    if(args.action!=="call")throw new Error("action需为list、read或call");
    if(args.arguments!==undefined && (!args.arguments || typeof args.arguments!=="object" || Array.isArray(args.arguments)))throw new Error("arguments必须是对象");
    const {callConfiguredMcpTool}=await import("./tool-executor");
    context?.signal?.throwIfAborted();
    // Re-check permission after loading the executor; settings can change mid-turn.
    const current=getQaMcpServers().find(item=>item.id===server.id && item.url===server.url);
    if(!current)throw new Error("该MCP授权已撤回，未执行调用");
    let raw:unknown;
    try {raw=await callConfiguredMcpTool(current,tool.name,(args.arguments||{}) as Record<string,unknown>,context?.signal);}
    catch {context?.signal?.throwIfAborted();throw new Error("MCP连接或调用失败，请检查该服务器的连接状态；未自动重试业务操作");}
    const result=raw as {isError?:boolean;content?:Array<{type?:string;text?:string;resource?:{text?:string};url?:string;uri?:string}>};
    const texts=(result.content||[]).flatMap(item=>item.type==="text"?[item.text||""]:item.resource?.text?[item.resource.text]:item.type==="resource_link"?[`资源链接：${item.uri||item.url||""}`]:[]);
    let text=texts.join("\n");
    if(!text)text="MCP已返回结果，但没有可显示的文本。";
    // Connection credentials must never be echoed by an error response.
    for(const secret of [current.accessToken,current.refreshToken,...Object.values(current.headers||{})].filter((s):s is string=>Boolean(s)))text=text.split(secret).join("[凭据已隐藏]");
    if(result.isError)throw new Error(text.slice(0,1000));
    const images=(result.content||[]).filter(item=>item.type==="image").length;
    if(images)text+=`\n[工具另返回${images}张图片；当前工坊此入口只接收文本，不能据此声称看到了图片内容。]`;
    const budget=getQaPageChars();
    return text.length>budget?text.slice(0,budget)+"\n[结果超过工坊单页限制，已截断；请使用该工具的分页或筛选参数继续读取。]":text;
}

export const QA_MCP_TOOL={
    name:"调用MCP",nativeName:"call_workshop_mcp",
    description:"调用用户在工坊配置中选中且在聊天工具箱已启用的MCP，复用现有地址和授权。先list列出服务器和工具，read读取工具inputSchema，再call传arguments对象。调用发布、发送、删除等有外部影响的工具时必须有用户对此操作的授权；失败不要擅自重复执行。不能自行修改工坊授权范围。",
    schemaLines:["[执行动作:调用MCP({\"action\":\"list\"})]","read/call需server_id和tool_name；call的arguments为工具参数对象。"],
    parameters:{type:"object",properties:{action:{type:"string",enum:["list","read","call"]},server_id:{type:"string"},tool_name:{type:"string"},arguments:{type:"object"}},required:["action"]},
    run:runQaMcp,
};
