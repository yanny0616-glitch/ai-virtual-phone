import { loadInstalledCustomApps } from "./custom-app-storage";
import { invokeCustomAppContextProvider } from "./custom-app-tool-runtime";

export type CustomAppPromptContextInput = {
  characterId: string;
  sessionId: string;
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
};

/** 每次装配独享的结果。空串也覆盖旧状态；绝不写 chat.setContext 的共享缓存。 */
export type CustomAppPromptContexts = Record<string, { text: string; label: string }>;

export async function prepareCustomAppPromptContexts(input: CustomAppPromptContextInput): Promise<CustomAppPromptContexts> {
  const apps = loadInstalledCustomApps().filter(app => app.manifest.extensions?.prompt?.contextProvider
    && app.permissions.includes("chat.context")
    && (app.permissions.includes("chat.read") || app.permissions.includes("chat.read.background")));
  const pairs = await Promise.all(apps.map(async app => {
    const timeoutMs = Math.max(100, Math.min(3000, app.manifest.extensions?.prompt?.contextProvider?.timeoutMs || 2000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let text = "";
    try {
      const raw = await Promise.race([
        invokeCustomAppContextProvider(app, input, timeoutMs),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("上下文准备超时")), timeoutMs); }),
      ]);
      if (typeof raw !== "string") throw new Error("上下文 provider 必须返回文字");
      text = raw.trim().slice(0, 4000);
    } catch (error) {
      // 超时/失败只省略该 APP 本轮内容，不回退到上一话题，也不阻塞聊天。
      console.warn(`[CustomAppPromptContext] ${app.id}:`, error instanceof Error ? error.message : String(error));
    } finally { clearTimeout(timer); }
    return [app.id, { text, label: "" }] as const;
  }));
  return Object.fromEntries(pairs);
}
