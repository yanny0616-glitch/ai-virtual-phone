// 配置只从环境变量读：systemd 用 EnvironmentFile=/etc/float-companion/env 注入。
// 密钥永远不打印、不写日志。

export type Config = {
  personalUrl: string;
  personalKey: string;
  apiToken: string;
  userId: string;
  port: number;
  dataDir: string;
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
    dataDir: env.COMPANION_DATA_DIR || "/var/lib/float-companion",
  };
}
