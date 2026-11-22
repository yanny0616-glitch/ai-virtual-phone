// 打字节奏 · 聊天插件（apiVersion 1）
// 角色一轮回复切成的多条气泡，按真人打字速度一条条放出，等待期间宿主显示「对方正在输入」。
// 只挂 message.beforeReveal 改 delayMs（2.0 起再填 pauseMs / stallAtMs / stallMs 拆分），宿主负责等；
// 本插件不落库、不改文本。
//
// 三档节奏：模型在气泡开头写 [快] / [慢]（宿主解析后放进 payload.tempo），没写算普通。
// - 快：脱口而出，几乎不停顿，打字也快；
// - 普通：和 1.x 完全一样的总时长，只是开头先空一小会儿再显示「正在输入」；
// - 慢：先沉默一阵，打得慢，还常常打到一半停下来（输入态消失一下再出现），像在斟酌。
export default {
  manifest: {
    id: "typing-rhythm",
    name: "打字节奏",
    apiVersion: 1,
    version: "2.0.0",
    author: "自制",
    description: "回复一句句慢慢发出来：每条气泡按字数 ÷ 打字速度等一会再出现，等待时显示「对方正在输入」。角色可以把气泡标成快 / 慢：快的秒回，慢的先沉默、打到一半还会停一下。",
    permissions: ["chat.read"],
    settings: [
      { key: "charsPerSec", label: "打字速度（字/秒）", type: "number", default: 5, description: "真人手机打字大约 3～6 字/秒；英文字母按 0.3 个字算" },
      { key: "jitter", label: "随机浮动（0～1）", type: "number", default: 0.35, description: "0.35 表示每条在 ±35% 内随机" },
      { key: "minDelayMs", label: "最短等待（毫秒）", type: "number", default: 700 },
      { key: "maxDelayMs", label: "最长等待（毫秒）", type: "number", default: 9000, description: "慢档可以再多等 3 秒；超过时整条按比例压缩" },
      { key: "firstDelayMs", label: "第一条也先等（毫秒）", type: "number", default: 500, description: "0 表示第一条立刻出" },
      { key: "mediaDelayMs", label: "表情/图片等待（毫秒）", type: "number", default: 1200 },
      { key: "tempoEnabled", label: "按语气分快慢", type: "boolean", default: true, description: "关掉后所有气泡都按普通速度" },
      { key: "stallEnabled", label: "犹豫时打到一半停一下", type: "boolean", default: true, description: "慢档气泡常常会，长句偶尔会：「正在输入」消失一下再出现" },
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
    const wobble = (spread) => 1 + (Math.random() * 2 - 1) * spread;

    // 打字量：中日韩字 1，emoji 0.8，字母数字和标点 0.3，空白不算
    const typingUnits = (s) => {
      let units = 0;
      for (const ch of String(s || "")) {
        if (/\s/.test(ch)) continue;
        if (/[぀-ヿ㐀-鿿가-힯豈-﫿]/.test(ch)) units += 1;
        else if (/\p{Extended_Pictographic}/u.test(ch)) units += 0.8;
        else if (/[‍️]/.test(ch)) continue;
        else units += 0.3;
      }
      return units;
    };

    // 各档相对普通档的系数：打字时长倍率、开头沉默占比 / 固定沉默、停顿概率与时长
    const TEMPO = {
      fast: { typing: 0.55, pauseShare: 0.08, pauseExtra: 0, stallChance: 0, stallMs: 0 },
      normal: { typing: 1, pauseShare: 0.2, pauseExtra: 0, stallChance: 0.12, stallMs: 800 },
      slow: { typing: 1.3, pauseShare: 0, pauseExtra: 1600, stallChance: 0.55, stallMs: 1500 },
    };

    const off = ctx.hooks.transform("message.beforeReveal", (p) => {
      if (p.isGroup && !bool("groupChat", true)) return p;
      if (p.streamed && !bool("applyWhenStreamed", true)) return p;
      const min = Math.max(0, num("minDelayMs", 700));
      const max = Math.max(min, num("maxDelayMs", 9000));
      const jitter = clamp(num("jitter", 0.35), 0, 1);
      const tempoKey = bool("tempoEnabled", true) && (p.tempo === "fast" || p.tempo === "slow") ? p.tempo : "normal";
      const tempo = TEMPO[tempoKey];

      if (p.index === 0 && tempoKey === "normal") {
        p.delayMs = Math.round(Math.max(0, num("firstDelayMs", 500)));
        return p;
      }
      if (p.mediaType && p.mediaType !== "quote") {
        p.delayMs = Math.round(num("mediaDelayMs", 1200) * (tempoKey === "fast" ? 0.5 : tempoKey === "slow" ? 1.5 : 1));
        return p;
      }

      const units = typingUnits(p.content);
      const cps = Math.max(0.5, num("charsPerSec", 5));
      const factor = wobble(jitter);
      // 普通档的总时长和 1.x 一致：字数 ÷ 速度，夹在上下限之间
      const base = p.index === 0
        ? Math.max(0, num("firstDelayMs", 500))
        : clamp((units / cps) * 1000 * factor, min, max);
      let typing = base * tempo.typing;
      let pause = tempoKey === "normal" ? base * tempo.pauseShare : tempo.pauseExtra * wobble(0.4) + typing * tempo.pauseShare;
      if (tempoKey === "normal") typing = base - pause;

      let stallMs = 0;
      let stallAt = 0;
      const stallEligible = tempoKey === "slow" ? typing >= 900 : tempoKey === "normal" ? units >= 18 : false;
      if (bool("stallEnabled", true) && stallEligible && Math.random() < tempo.stallChance) {
        stallMs = tempo.stallMs * wobble(0.4);
        stallAt = typing * (0.35 + Math.random() * 0.3);
      }

      // 单条总等待超过上限时三段按比例压缩（慢档多给 3 秒）
      const cap = tempoKey === "slow" ? max + 3000 : max;
      let total = pause + typing + stallMs;
      if (total > cap && total > 0) {
        const k = cap / total;
        pause *= k; typing *= k; stallMs *= k; stallAt *= k;
        total = cap;
      }
      p.delayMs = Math.round(total);
      p.pauseMs = Math.round(pause);
      if (stallMs > 0) {
        p.stallAtMs = Math.round(stallAt);
        p.stallMs = Math.round(stallMs);
      }
      return p;
    }, { priority: 50 });

    return () => off();
  },
};
