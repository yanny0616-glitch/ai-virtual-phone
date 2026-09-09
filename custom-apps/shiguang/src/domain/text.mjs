// 纯文本工具：不依赖宿主，Node 测试直接 import。

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g;

export function clean(text) {
  return String(text || "").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

// 只过滤缺乏辨识度的独立词，保留包含它们的具体短语（如「喜欢抹茶」）。
const SEARCH_STOP_WORDS = new Set([
  "今天", "昨天", "明天", "现在", "刚才", "最近", "上次", "下次", "这次", "当时", "以后", "之前", "之后",
  "我们", "你们", "他们", "她们", "自己", "对方", "用户", "角色", "这个", "那个", "这些", "那些", "什么", "怎么", "为什么",
  "一起", "在一起", "喜欢", "觉得", "知道", "记得", "记忆", "回忆", "事情", "东西", "时候", "时间", "聊天", "对话",
  "开心", "快乐", "美好", "感觉", "真的", "非常", "特别", "有点", "还是", "也是", "就是", "已经", "可以", "可能",
  "没有", "不是", "因为", "所以", "但是", "然后", "如果", "这样", "那样", "一次", "一个", "一下", "一些", "一直",
  "the", "and", "with", "that", "this", "have", "was", "are", "you", "our", "today", "remember",
]);
const wordSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
const SINGLE_FILLERS = new Set(Array.from("我你他她它的了呢啊吗是在很都也和不没太就把让给被想去来买吃说要又好与及"));

export function normalizeKeywords(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = clean(value);
    if (key.length < 2 || SEARCH_STOP_WORDS.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** 按词边界匹配，避免把所有相邻两字都当关键词。旧浏览器保守退回完整词串。 */
export function searchTerms(text) {
  const parts = wordSegmenter ? Array.from(wordSegmenter.segment(String(text || ""))) : [];
  const words = wordSegmenter ? parts.filter(part => part.isWordLike).map(part => part.segment)
    : (String(text || "").match(/[\p{L}\p{N}]+/gu) || []);
  // 分词器可能把外来专名拆成单字（如「提拉米苏」）；保留连续专名片段。
  let run = "";
  for (const part of [...parts, { segment: "", isWordLike: false }]) {
    if (part.isWordLike && /^[\p{Script=Han}]$/u.test(part.segment) && !SINGLE_FILLERS.has(part.segment)) run += part.segment;
    else { if (run.length >= 2) words.push(run); run = ""; }
  }
  return normalizeKeywords(words).map(clean).filter(word => !/^\d+$/.test(word));
}

/** 双字重叠数：无模型、无向量的本地相关性。 */
export function overlap(text, context) {
  const a = clean(text), b = clean(context);
  if (!a || !b) return 0;
  const grams = new Set();
  for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2));
  let matches = 0;
  for (const gram of grams) if (b.includes(gram)) matches++;
  return matches;
}

/** 与宿主 token-counter 同一公式，预算口径才一致。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (String(text).match(CJK) || []).length;
  return Math.ceil(cjk / 1.5 + (String(text).length - cjk) / 4);
}

/** FNV-1a，给记录造短而稳定的 id（宿主 db 的 id 上限 120 字符）。 */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export function safeId(value) {
  return String(value || "").replace(/[^\w.-]+/g, "_").slice(0, 60);
}

export function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
