// 打字节奏 · 聊天插件（apiVersion 1）
// 角色一轮回复切成的多条气泡，按真人打字速度一条条放出，等待期间宿主显示「对方正在输入」。
// 只挂 message.beforeReveal 改 delayMs，宿主负责等；本插件不落库、不改文本。
export default {
  manifest: {
    id: "typing-rhythm",
    name: "打字节奏",
    apiVersion: 1,
    version: "1.0.0",
    author: "自制",
    description: "回复一句句慢慢发出来：每条气泡按字数 ÷ 打字速度等一会再出现，带随机浮动，等待时显示「对方正在输入」。速度和上下限可调。",
    permissions: ["chat.read"],
    settings: [
      { key: "charsPerSec", label: "打字速度（字/秒）", type: "number", default: 5, description: "真人手机打字大约 3～6 字/秒" },
      { key: "jitter", label: "随机浮动（0～1）", type: "number", default: 0.35, description: "0.35 表示每条在 ±35% 内随机" },
      { key: "minDelayMs", label: "最短等待（毫秒）", type: "number", default: 700 },
      { key: "maxDelayMs", label: "最长等待（毫秒）", type: "number", default: 9000 },
      { key: "firstDelayMs", label: "第一条也先等（毫秒）", type: "number", default: 500, description: "0 表示第一条立刻出" },
      { key: "mediaDelayMs", label: "表情/图片等待（毫秒）", type: "number", default: 1200 },
      { key: "applyWhenStreamed", label: "开了流式也按节奏放出", type: "boolean", default: true, description: "关掉则流式会话沿用宿主默认（一次放完）" },
      { key: "groupChat", label: "群聊也生效", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const num = (key, fallback) => {
      const v = Number(ctx.system.settings.get(key));
      return Number.isFinite(v) ? v : fallback;
    };
    const bool = (key, fallback) => {
      const v = ctx.system.settings.get(key);
      return typeof v === "boolean" ? v : fallback;
    };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const textLength = (s) => String(s || "").replace(/\s+/g, "").length;

    const off = ctx.hooks.transform("message.beforeReveal", (p) => {
      if (p.isGroup && !bool("groupChat", true)) return p;
      if (p.streamed && !bool("applyWhenStreamed", true)) return p;
      const min = Math.max(0, num("minDelayMs", 700));
      const max = Math.max(min, num("maxDelayMs", 9000));
      let delay;
      if (p.index === 0) {
        delay = Math.max(0, num("firstDelayMs", 500));
      } else if (p.mediaType && p.mediaType !== "quote") {
        delay = num("mediaDelayMs", 1200);
      } else {
        const cps = Math.max(0.5, num("charsPerSec", 5));
        const jitter = clamp(num("jitter", 0.35), 0, 1);
        const factor = 1 + (Math.random() * 2 - 1) * jitter;
        delay = clamp((textLength(p.content) / cps) * 1000 * factor, min, max);
      }
      p.delayMs = Math.round(delay);
      return p;
    }, { priority: 50 });

    return () => off();
  },
};
