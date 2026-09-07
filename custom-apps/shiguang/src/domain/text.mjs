// 纯文本工具：不依赖宿主，Node 测试直接 import。

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g;

export function clean(text) {
  return String(text || "").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
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
