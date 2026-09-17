export async function requestXhsApi(path: "status" | "cookie" | "call", body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = process.env.XHS_BROWSER_TOKEN?.trim();
    if (!token) throw new Error("小红书服务尚未配置");
    const response = await fetch(`http://127.0.0.1:18061/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(100000), ...(signal ? [signal] : [])]),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "小红书服务暂时不可用");
    return result.data;
}
