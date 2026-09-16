// 配置只从环境变量读：systemd 用 EnvironmentFile=/etc/float-companion/env 注入。
// 密钥永远不打印、不写日志。

export type Config = {
  personalUrl: string;
  personalKey: string;
  apiToken: string;
  userId: string;
  port: number;
  /** 监听地址，逗号分隔，默认只 127.0.0.1 */
  bind: string[];
  dataDir: string;
  /** shadow 只记录不调模型不发；live 真发。启动后以 SQLite 里存的为准 */
  mode: "shadow" | "live";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const personalUrl = (env.PERSONAL_SUPABASE_URL || "").replace(/\/+$/, "");
  const personalKey = env.PERSONAL_SUPABASE_SECRET_KEY || "";
  if (!/^https:\/\/.+/.test(personalUrl)) throw new Error("PERSONAL_SUPABASE_URL 未配置或不是 https 地址");
  if (!personalKey) throw new Error("PERSONAL_SUPABASE_SECRET_KEY 未配置");
  return {
    personalUrl,
    personalKey,
    apiToken: env.COMPANION_API_TOKEN || "",
    userId: env.COMPANION_USER_ID || "",
    port: Number(env.COMPANION_PORT) || 18070,
    bind: (env.COMPANION_BIND || "127.0.0.1").split(",").map(s => s.trim()).filter(Boolean),
    dataDir: env.COMPANION_DATA_DIR || "/var/lib/float-companion",
    mode: env.COMPANION_MODE === "live" ? "live" : "shadow",
  };
}
