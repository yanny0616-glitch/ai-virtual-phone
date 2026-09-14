import {
    loadMcpServers,saveMcpServers,createMcpServer,
    loadRestTools,saveRestTools,createRestTool,
    loadCompositeTools,saveCompositeTools,createCompositeTool,
} from "./tool-storage";
import type { McpServerConfig,RestToolConfig,CompositeToolConfig } from "./settings-types";

type Entry = McpServerConfig | RestToolConfig | CompositeToolConfig;
type Kind = "mcp" | "rest" | "composite";
const fields: Record<Kind,string[]> = {
    mcp:["name","description","url","enabled","directFetch","headers","accessToken"],
    rest:["name","description","endpoint","method","enabled","directFetch","headers","fixedParams","bodyTemplate","parameterSchema","packageId"],
    composite:["name","description","enabled","parameterSchema","steps","outputTemplate","packageId"],
};
function entries(kind:Kind):Entry[] {return kind==="mcp"?loadMcpServers():kind==="rest"?loadRestTools():loadCompositeTools();}
function save(kind:Kind,rows:Entry[]) {
    if(kind==="mcp")saveMcpServers(rows as McpServerConfig[]);
    else if(kind==="rest")saveRestTools(rows as RestToolConfig[]);
    else saveCompositeTools(rows as CompositeToolConfig[]);
}
function safeUrl(value:string):string {
    try {const u=new URL(value);u.username="";u.password="";for(const key of [...u.searchParams.keys()])u.searchParams.set(key,"[已隐藏]");u.pathname=u.pathname.replace(/\/(mcp|sse)\/[^/]+/g,"/$1/[已隐藏]");return u.href;}catch{return "[地址已配置]";}
}
export function redactToolboxEntry(entry:Entry) {
    const raw=entry as unknown as Record<string,unknown>, result:Record<string,unknown>={};
    for(const [key,value] of Object.entries(raw)) {
        if(/token|secret|sessionId|headers|fixedParams/i.test(key)) {if(value)result[key+"Configured"]=true;continue;}
        result[key]=(key==="url" || key==="endpoint") && typeof value==="string" ? safeUrl(value) : value;
    }
    return result;
}
function validatePatch(kind:Kind,patch:Record<string,unknown>) {
    for(const [key,value] of Object.entries(patch)) {
        if(!fields[kind].includes(key))throw new Error(`不能修改字段：${key}`);
        if(["enabled","directFetch"].includes(key)) {if(typeof value!=="boolean")throw new Error(`${key}必须是布尔值`);}
        else if(["headers","fixedParams"].includes(key)) {
            if(!value || typeof value!=="object" || Array.isArray(value) || Object.values(value).some(v=>typeof v!=="string"))throw new Error(`${key}必须是字符串值对象`);
        } else if(key==="steps") {
            if(!Array.isArray(value) || value.length>30 || value.some(step=>!step || typeof step!=="object" || typeof step.id!=="string" || (step.argsTemplate!==undefined && typeof step.argsTemplate!=="string")))throw new Error("steps必须是带id的步骤数组，最多30步");
        } else if(typeof value!=="string")throw new Error(`${key}必须是字符串`);
    }
    if(patch.name!==undefined && !String(patch.name).trim())throw new Error("名称不能为空");
    if(patch.method!==undefined && !["GET","POST"].includes(String(patch.method)))throw new Error("method只支持GET或POST");
    if(patch.url!==undefined) {
        const url=new URL(String(patch.url));if(!["http:","https:"].includes(url.protocol) || url.username || url.password)throw new Error("MCP地址需为HTTP或HTTPS，凭据请放Token字段");
    }
    if(patch.parameterSchema!==undefined) {
        const schema=JSON.parse(String(patch.parameterSchema));if(!schema || typeof schema!=="object" || Array.isArray(schema))throw new Error("parameterSchema需为JSON对象字符串");
    }
}

export async function manageQaToolbox(args:Record<string,unknown>,context?:{signal?:AbortSignal}):Promise<string> {
    const kind=(args.kind||"mcp") as Kind;
    if(!Object.hasOwn(fields,kind))throw new Error("kind需为mcp、rest或composite");
    const rows=entries(kind), id=typeof args.id==="string"?args.id:"";
    if(args.action==="list")return JSON.stringify({kind,items:rows.map(row=>({id:row.id,name:row.name,enabled:row.enabled}))});
    const existing=rows.find(row=>row.id===id);
    if(args.action==="read") {if(!existing)throw new Error("找不到配置，请先list获取id");return JSON.stringify(redactToolboxEntry(existing));}
    if(args.action==="discover") {
        if(kind!=="mcp" || !existing)throw new Error("discover需要已有MCP的id");
        const server=existing as McpServerConfig;
        try {
            const {discoverMcpTools}=await import("./tool-executor");
            const tools=await discoverMcpTools(server.url,server);
            context?.signal?.throwIfAborted();
            // Discovery may persist OAuth state; read again rather than overwriting it.
            const fresh=loadMcpServers();const found=fresh.find(row=>row.id===id);
            if(!found || found.url!==server.url)throw new Error("配置已变化");
            saveMcpServers(fresh.map(row=>row.id===id?{...row,discoveredTools:tools,updatedAt:Date.now()}:row));
            return JSON.stringify({id,tools});
        } catch {throw new Error("发现工具失败，请在聊天工具箱检查该MCP的连接地址和授权状态；未更改启用状态");}
    }
    if(args.action!=="save")throw new Error("action需为list、read、save或discover");
    if(id && !existing)throw new Error("配置id不存在，未创建新项");
    const patch=args.config;
    if(!patch || typeof patch!=="object" || Array.isArray(patch))throw new Error("config必须是对象，只传需要修改的字段");
    validatePatch(kind,patch as Record<string,unknown>);
    const changes=patch as Record<string,unknown>;
    if(!existing && (typeof changes.name!=="string" || (kind==="mcp" && !changes.url)))throw new Error("新建需要name；MCP还需要url");
    const base=existing || (kind==="mcp"?createMcpServer(String(changes.name),String(changes.url)):kind==="rest"?createRestTool(String(changes.name)):createCompositeTool(String(changes.name)));
    const next={...base,...changes,updatedAt:Date.now()} as Entry;
    if(kind==="mcp" && existing && changes.url!==undefined && changes.url!==(existing as McpServerConfig).url) {
        const m=next as McpServerConfig;m.discoveredTools=undefined;m.sessionId=undefined;
        if(changes.accessToken===undefined)m.accessToken=undefined;
        m.refreshToken=undefined;m.oauthClientSecret=undefined;m.oauthClientId=undefined;
        m.oauthTokenEndpoint=undefined;m.oauthAuthorizationEndpoint=undefined;m.oauthRegistrationEndpoint=undefined;
        m.oauthAuthorizationServer=undefined;m.oauthProtectedResourceMetadataUrl=undefined;m.tokenExpiresAt=undefined;
        if(changes.headers===undefined)m.headers=undefined;
    }
    context?.signal?.throwIfAborted();
    save(kind,existing?rows.map(row=>row.id===id?next:row):[...rows,next]);
    return JSON.stringify({saved:true,location:"设置 → 聊天工具箱",entry:redactToolboxEntry(next),notice:"此配置供角色聊天调用；工坊这里只管理配置，不执行该工具的业务动作。"});
}

export const QA_TOOLBOX_TOOL = {
    name:"配置聊天工具箱",nativeName:"configure_chat_toolbox",
    description:"查看、创建、修改和启停聊天工具箱的MCP、REST或组合工具，MCP可发现工具。直接修改当前用户的同一份本地工具箱配置，不写仓库。先list/read确认现有项，save只传要改的字段；凭据不回显。更换MCP地址会清除旧授权与工具缓存，需要重新发现。配置与执行是不同操作，不要声称工坊已调用了业务工具。",
    schemaLines:["[执行动作:配置聊天工具箱({\"action\":\"list\",\"kind\":\"mcp\"})]","save：已有项传id，config可写name/url/enabled/directFetch/accessToken/headers等。discover：传MCP的id。"],
    parameters:{type:"object",properties:{action:{type:"string",enum:["list","read","save","discover"]},kind:{type:"string",enum:["mcp","rest","composite"]},id:{type:"string"},config:{type:"object",description:"只传需要修改的配置字段；新增默认关闭，可显式enabled:true启用"}},required:["action"]},
    run:manageQaToolbox,
};
