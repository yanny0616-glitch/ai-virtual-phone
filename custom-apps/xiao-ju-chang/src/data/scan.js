// 不认识的 JSON（酒馆预设、角色卡、别人的生成器导出）递归扫一遍，把「名字 + 一大段文字」列出来让用户挑
const SCAN_NAME_KEYS = ["name", "title", "comment", "label", "identifier", "key", "名称", "标题", "名字"];
const SCAN_SKIP_KEYS = new Set(["id", "avatar", "image", "img", "src", "url", "href", "base64", "dataUrl", "dataURL", "createdAt", "updatedAt", "create_date", "spec", "spec_version", "chat", "chat_metadata", "extensions"]);
const SCAN_MIN_LEN = 24, SCAN_MAX = 400, SCAN_DEPTH = 12;
const looksLikeProse = s => s.length >= SCAN_MIN_LEN && !/^(data:|https?:\/\/)/.test(s) && (/\s/.test(s) || /[　-鿿]/.test(s));
function scanLooseJson(root) {
  const out = [], seen = new Set();
  const push = (name, content, path) => {
    const text = content.trim();
    if (seen.has(text) || out.length >= SCAN_MAX) return;
    seen.add(text);
    out.push({ name: String(name || "").trim().slice(0, 60) || `第 ${out.length + 1} 段`, content: text, path });
  };
  const nameOf = obj => { for (const k of SCAN_NAME_KEYS) { const v = obj[k]; if (typeof v === "string" && v.trim() && v.length <= 80) return [k, v.trim()]; } return ["", ""]; };
  const walk = (node, path, parentKey, depth) => {
    if (depth > SCAN_DEPTH || node == null) return;
    if (typeof node === "string") { if (looksLikeProse(node)) push(parentKey, node, path); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, parentKey, depth + 1)); return; }
    if (typeof node !== "object") return;
    const [nameKey, name] = nameOf(node);
    const entries = Object.entries(node).filter(([k]) => k !== nameKey && !SCAN_SKIP_KEYS.has(k));
    const longCount = entries.filter(([, v]) => typeof v === "string" && looksLikeProse(v)).length;
    for (const [k, v] of entries) {
      if (typeof v === "string") { if (looksLikeProse(v)) push(longCount > 1 && name ? `${name} · ${k}` : (name || k), v, `${path}.${k}`); }
      else if (v && typeof v === "object") walk(v, `${path}.${k}`, k, depth + 1);
    }
  };
  walk(root, "$", "", 0);
  return out;
}
