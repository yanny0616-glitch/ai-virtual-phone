// 写入前校验完整包；旧库坏行隔离保留，避免一条坏数据拖垮所有页面。
function validateRow(name, input) {
  const object = (v, at) => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${at} 必须是对象。`); };
  object(input, name);
  const r = clone(input);
  const string = (obj, key, required = false) => {
    if (obj[key] === undefined && !required) return;
    if (typeof obj[key] !== "string" || (required && !obj[key].trim())) throw new Error(`${name}.${key} 必须是${required ? "非空" : ""}文本。`);
  };
  const strings = (obj, key) => {
    if (obj[key] === undefined) { obj[key] = []; return; }
    if (!Array.isArray(obj[key]) || obj[key].some(v => typeof v !== "string")) throw new Error(`${name}.${key} 必须是文本数组。`);
  };
  const number = (obj, key, min, max) => {
    if (obj[key] !== undefined && (typeof obj[key] !== "number" || !Number.isFinite(obj[key]) || obj[key] < min || obj[key] > max)) throw new Error(`${name}.${key} 数值无效。`);
  };
  const choice = (obj, key, values) => { if (obj[key] !== undefined && !values.includes(obj[key])) throw new Error(`${name}.${key} 选项无效。`); };
  for (const key of ["id", "createdAt", "updatedAt"]) string(r, key);
  if (["prompts", "randoms"].includes(name)) { string(r, "title", true); string(r, "content", true); strings(r, "tags"); }
  if (name === "preambles") { string(r, "name", true); string(r, "content", true); }
  if (name === "macros") {
    string(r, "name", true); choice(r, "kind", ["words", "number"]);
    if (!r.kind) throw new Error("宏缺少类型。");
    if (r.kind === "words") { strings(r, "values"); if (!r.values.length) throw new Error("词表不能为空。"); }
    else { number(r, "min", -1e9, 1e9); number(r, "max", -1e9, 1e9); if ((r.min ?? 1) > (r.max ?? 10)) throw new Error("宏最小值不能大于最大值。"); }
  }
  if (name === "combos") {
    string(r, "name", true); strings(r, "tags"); strings(r, "promptIds"); string(r, "preambleId"); string(r, "whoText");
    choice(r, "who", ["persona", "custom", "observer"]);
    for (const key of ["rawChannel", "writeBack"]) if (r[key] !== undefined && typeof r[key] !== "boolean") throw new Error(`${key} 必须是开关。`);
    r.random ??= { count: 0 }; object(r.random, "random"); strings(r.random, "include"); strings(r.random, "exclude"); number(r.random, "count", 0, 5);
    r.output ??= { mode: "text", length: "default" }; object(r.output, "output");
    choice(r.output, "mode", ["text", "html", "mixed"]); choice(r.output, "length", ["default", "short", "medium", "long", "custom"]); choice(r.output, "style", ["free", "vars", "strict"]);
    string(r.output, "wrapTag"); if (r.output.wrapTag && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(r.output.wrapTag)) throw new Error("包裹标签名称无效。");
    number(r.output, "customChars", 0, 1e6);
    if (r.output.staged !== undefined && typeof r.output.staged !== "boolean") throw new Error("分两步出必须是开关。");
    r.memory ??= { mode: "host", rounds: 12 }; object(r.memory, "memory"); choice(r.memory, "mode", ["host", "recent", "none"]); number(r.memory, "rounds", 1, 50);
    number(r, "weight", 0, 9); number(r, "useCount", 0, Number.MAX_SAFE_INTEGER);
    if (r.plays !== undefined) { object(r.plays, "plays"); for (const v of Object.values(r.plays)) if (!Number.isFinite(v) || v < 0) throw new Error("角色计数无效。"); }
    if (r._virtualPrompts !== undefined) { if (!Array.isArray(r._virtualPrompts)) throw new Error("虚拟提示词必须是数组。"); r._virtualPrompts = r._virtualPrompts.map(p => validateRow("prompts", p)); }
    if (r._dependencies !== undefined) {
      const d = r._dependencies; object(d, "dependencies");
      if (d.preamble != null) d.preamble = validateRow("preambles", d.preamble);
      for (const key of ["prompts", "randoms", "macros"]) { if (!Array.isArray(d[key])) throw new Error(`快照 ${key} 必须是数组。`); d[key] = d[key].map(v => validateRow(key, v)); }
      if (d.length != null) { object(d.length, "length"); number(d.length, "chars", 1, 1e6); string(d.length, "label"); }
    }
  }
  if (["favorites", "recents"].includes(name)) {
    for (const key of ["title", "raw", "characterId", "characterName", "comboId", "comboName", "favoriteId", "recentId", "favoritedAt", "model"]) string(r, key);
    r.segments ??= []; if (!Array.isArray(r.segments)) throw new Error("正文段落必须是数组。");
    for (const seg of r.segments) { object(seg, "segment"); string(seg, "content", true); choice(seg, "type", ["text", "html"]); }
    r.snapshot ??= {}; object(r.snapshot, "snapshot");
    for (const key of ["randoms", "prompts"]) strings(r.snapshot, key);
    for (const key of ["output", "memory"]) if (r.snapshot[key] !== undefined) object(r.snapshot[key], key);
    if (r.comboCopy) r.comboCopy = validateRow("combos", r.comboCopy);
  }
  return r;
}
function validateBundle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.app !== "float.xiaojuchang") throw new Error("不是小剧场导出包。");
  if (input.version !== undefined && input.version !== 1) throw new Error("暂不支持此导出包版本。");
  const data = clone(input);
  for (const name of ["preambles", "prompts", "randoms", "macros", "combos", "favorites"]) {
    if (data[name] === undefined) { data[name] = []; continue; }
    if (!Array.isArray(data[name])) throw new Error(`${name} 必须是数组。`);
    data[name] = data[name].map(r => validateRow(name, r));
    const ids = data[name].map(r => r.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error(`${name} 包含重复 ID。`);
  }
  const promptIds = new Set([...(state.prompts || []), ...data.prompts].map(r => r.id));
  const preambleIds = new Set([...(state.preambles || []), ...data.preambles].map(r => r.id));
  for (const combo of data.combos) {
    if (combo._dependencies) continue;
    if (combo.promptIds.some(id => !promptIds.has(id))) throw new Error(`「${combo.name}」引用了不存在的提示词。`);
    if (combo.preambleId && !preambleIds.has(combo.preambleId)) throw new Error(`「${combo.name}」引用了不存在的前置要求。`);
  }
  return data;
}
