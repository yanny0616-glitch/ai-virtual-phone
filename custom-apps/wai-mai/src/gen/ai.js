// ── 模型调用：现编店铺（通用模型，不带人设）、问角色想吃什么（走角色链路）──

/** 从模型回复里抠出第一段 JSON；抠不出来返回 null */
function extractJson(text) {
  const src = String(text || "").replace(/```(?:json)?/gi, "");
  const start = src.search(/[\[{]/);
  if (start < 0) return null;
  const open = src[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, escNext = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (escNext) escNext = false; else if (ch === "\\") escNext = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) { try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

/** 本地搜：店名、分类、菜名、当初的搜索词里有这个词就算 */
function searchLocal(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return allShops();
  return allShops().filter(s => [s.name, s.category, s.tagline, s.query, ...s.dishes.map(d => d.name)].some(t => String(t || "").toLowerCase().includes(q)));
}

async function generateShops(query) {
  const locale = state.settings.locale ? `地区或世界观：${state.settings.locale}。` : "";
  const taboo = state.settings.userTaboo ? `点餐人的忌口：${state.settings.userTaboo}（菜单里可以有，但别全是）。` : "";
  const result = await api.ai.chat({
    messages: [
      { role: "system", content: "你在给一个外卖 APP 生成虚构的店铺和菜单。只输出 JSON，不要解释，不要 Markdown。" },
      { role: "user", content: `用户想吃 / 想买：「${query}」。${locale}${taboo}\n请编 3 家卖这个的店，风格各不相同（比如一家老店、一家新派、一家平价），店名不要用真实连锁品牌。每家 6 道商品，至少 2 道直接对应用户想要的东西，其余是这家店会搭着卖的。\n输出格式：{"shops":[{"name":"店名","emoji":"最能代表这家店的一个 emoji","category":"${CATEGORIES.slice(1).join(" / ")} 里选一个","tagline":"一句招牌话，20 字内","rating":4.2到4.9,"minOrder":起送价,"fee":配送费,"off":[满多少,减多少],"dishes":[{"name":"菜名","emoji":"这道商品的一个 emoji","price":价格数字,"desc":"一句话，20 字内","tag":"招牌 或 空字符串"}]}]}\n价格用人民币，贴近真实外卖价格。` },
    ],
    timeoutMs: 90000,
  });
  const data = extractJson(result && (result.text || result.content));
  const list = Array.isArray(data) ? data : data && Array.isArray(data.shops) ? data.shops : null;
  if (!list || !list.length) throw new Error("模型没有按格式返回店铺，可以再试一次");
  const palette = ["#e8663d", "#c2783a", "#5f9d6b", "#4f86b8", "#a1608f", "#b98f34"];
  const added = await addAiShops(list.map((s, i) => ({ ...s, color: palette[(hashSeed(String(s.name)) + i) % palette.length] })), query);
  if (!added.length) throw new Error("生成的店铺和已有的重名了，换个说法再搜");
  return added;
}

/** 问角色此刻想吃什么：返回 { word, line }，word 用来搜店，line 是 TA 的原话 */
async function askCraving(charId) {
  const { charName, userName } = await namesFor(charId);
  const favs = favorites(charId);
  const result = await api.ai.generate({
    characterId: charId,
    appTags: ["waimai", "crave"],
    instruction: `${userName}打开了外卖 APP，想给${charName}点一份外卖，正在问${charName}现在想吃什么。${favs.length ? `${charName}之前收到过：${favs.join("、")}。` : ""}现在是 ${hhmm(Date.now())}。`,
  });
  const text = String(result && result.text || "").trim();
  const m = text.match(/[\[【]想吃[:：]\s*([^:：\]】]+)[:：]\s*([^\]】]*)[\]】]/);
  if (m) return { word: m[1].trim().slice(0, 12), line: m[2].trim() };
  // 没按格式写：整句当原话，不猜关键词
  return { word: "", line: text.replace(/[\[\]【】]/g, "").slice(0, 120) };
}
