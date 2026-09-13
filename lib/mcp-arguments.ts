/** Normalize only JSON containers explicitly declared by the tool schema. */
export function normalizeMcpArguments(args: Record<string, unknown>, schema: unknown): Record<string, unknown> {
    function visit(value: unknown, rule: unknown, path: string, depth: number): unknown {
        if (depth > 20) throw new Error(`MCP参数嵌套过深：${path}`);
        const r = rule && typeof rule === "object" ? rule as {type?:unknown;properties?:Record<string,unknown>;items?:unknown;required?:string[]} : {};
        if ((r.type === "object" || r.type === "array") && typeof value === "string") {
            try {value=JSON.parse(value);} catch {throw new Error(`MCP参数 ${path} 必须是${r.type === "object" ? "对象 {}" : "数组 []"}，不能是普通字符串`);}
        }
        if (r.type === "object") {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP参数 ${path} 必须是对象 {}`);
            const obj=value as Record<string,unknown>;
            for (const key of r.required || []) if (!(key in obj)) throw new Error(`MCP缺少参数 ${path}.${key}，请按工具的 inputSchema 组织嵌套对象`);
            return Object.fromEntries(Object.entries(obj).map(([key,item])=>[key,r.properties?.[key] ? visit(item,r.properties[key],`${path}.${key}`,depth+1) : item]));
        }
        if (r.type === "array") {
            if (!Array.isArray(value)) throw new Error(`MCP参数 ${path} 必须是数组 []`);
            return value.map((item,index)=>visit(item,r.items,`${path}[${index}]`,depth+1));
        }
        return value;
    }
    return visit(args,schema,"arguments",0) as Record<string,unknown>;
}
