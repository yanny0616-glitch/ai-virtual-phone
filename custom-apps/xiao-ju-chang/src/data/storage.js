// ── 存储：settings 一行；combos / prompts / randoms / macros / preambles / favorites / recents 各一行一条 ──
const COLLECTIONS = ["combos", "prompts", "randoms", "macros", "preambles", "favorites", "recents"];
const freshSettings = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let writeQueue = Promise.resolve();
function writeData(task) { const job = writeQueue.then(task); writeQueue = job.catch(() => {}); return job; }

async function loadSettings() {
  const rows = await api.db.list("settings", { limit: 5 });
  const row = rows && rows[0];
  const merged = { ...freshSettings(), ...(row || {}) };
  if (!row) { const created = await api.db.create("settings", freshSettings()); merged.id = created.id; }
  state.settings = merged;
  return merged;
}
let saveTimer = 0;
function saveSettings(patch) {
  Object.assign(state.settings, patch || {});
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { const { id, ...data } = state.settings; await writeData(() => api.db.update("settings", id, clone(data))); } catch (e) { fail(e); }
  }, 250);
}

async function readAllRows(name) {
  const rows = [], pages = new Set();
  for (let offset = 0; ; offset += 500) {
    const page = await api.db.list(name, { limit: 500, offset });
    if (!Array.isArray(page)) throw new Error("宿主返回了无效的数据列表。");
    const signature = JSON.stringify(page.map(r => r && r.id));
    if (page.length && pages.has(signature)) throw new Error("读取超过 500 条数据需要新版宿主，请先更新宿主。");
    pages.add(signature); rows.push(...page);
    if (page.length < 500) return rows;
  }
}
async function loadCollection(name) {
  const rows = await readAllRows(name), seen = new Set(), list = [], invalid = [];
  for (const row of rows) {
    try {
      if (!row || !row.id) throw new Error("缺少 ID");
      const valid = validateRow(name, row);
      if (!seen.has(valid.id)) { list.push(valid); seen.add(valid.id); }
    } catch { invalid.push(row); }
  }
  (state.invalidRecords ||= {})[name] = invalid;
  state[name] = list;
  return list;
}
async function loadAll() { await Promise.all(COLLECTIONS.map(loadCollection)); }

async function seedIfEmpty(force) {
  if (state.settings.seeded && !force) return;
  const now = new Date().toISOString();
  const idMap = {};
  const keyOf = r => r.title || r.name || "";
  const seed = async (name, rows) => {
    for (const r of rows) {
      const { id: seedId, ...rest } = clone(r);
      const exist = state[name].find(x => keyOf(x) === keyOf(r));
      if (exist) { if (seedId) idMap[seedId] = exist.id; continue; }
      const created = await api.db.create(name, { ...rest, createdAt: now, updatedAt: now });
      state[name].push(created);
      if (seedId) idMap[seedId] = created.id;
    }
  };
  await seed("preambles", DEFAULT_PREAMBLES);
  await seed("prompts", DEFAULT_PROMPTS);
  await seed("randoms", DEFAULT_RANDOMS);
  await seed("macros", DEFAULT_MACROS);
  await seed("combos", DEFAULT_COMBOS.map(c => ({
    ...c, preambleId: idMap[c.preambleId] || c.preambleId,
    promptIds: (c.promptIds || []).map(id => idMap[id] || id), useCount: 0, lastUsedAt: "",
  })));
  saveSettings({ seeded: true });
}

// 同一草稿的重复点击共享一次写入；读取、合并、落库和更新内存全部在队列内。
const pendingRows = new WeakMap();
function upsert(name, row) {
  if (pendingRows.has(row)) return pendingRows.get(row);
  const patch = clone(row);
  const job = writeData(async () => {
    const list = state[name], now = new Date().toISOString();
    const idx = patch.id ? list.findIndex(x => x.id === patch.id) : -1;
    if (idx >= 0) {
      const { id, ...data } = validateRow(name, { ...list[idx], ...patch, updatedAt: now });
      const saved = await api.db.update(name, id, data);
      if (!saved) throw new Error("记录已不存在，请重新打开 App。");
      list[idx] = saved; return saved;
    }
    const data = validateRow(name, { ...patch, createdAt: patch.createdAt || now, updatedAt: now });
    if (!data.id) delete data.id;
    const created = await api.db.create(name, data);
    list.push(created); row.id = created.id;
    return created;
  });
  pendingRows.set(row, job);
  const cleanup = () => { if (pendingRows.get(row) === job) pendingRows.delete(row); };
  job.then(cleanup, cleanup);
  return job;
}
function favoriteOf(result) {
  return state.favorites.find(f => f.id === result.favoriteId || f.id === result.id || (result.id && f.recentId === result.id)) || null;
}
async function unlinkFavorites(ids) {
  for (const r of state.recents) if (ids.has(r.favoriteId)) {
    await api.db.update("recents", r.id, { favoriteId: "" }); r.favoriteId = "";
  }
  if (state.result && ids.has(state.result.favoriteId)) state.result.favoriteId = "";
}
function remove(name, id) {
  return writeData(async () => {
    await api.db.delete(name, id);
    state[name] = state[name].filter(x => x.id !== id);
    if (name === "favorites") await unlinkFavorites(new Set([id]));
  });
}
function clearCollection(name) {
  return writeData(async () => {
    const rows = await readAllRows(name);
    for (const row of rows) await api.db.delete(name, row.id);
    state[name] = [];
    if (state.invalidRecords) state.invalidRecords[name] = [];
    if (name === "favorites") await unlinkFavorites(new Set(rows.map(r => r.id)));
  });
}

/** 最近：超出上限自动挤掉最旧的 */
async function pushRecent(item) {
  const saved = await upsert("recents", item);
  const keep = Math.max(1, Number(state.settings.recentKeep) || 10);
  const sorted = [...state.recents].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const old of sorted.slice(keep)) await remove("recents", old.id);
  return saved;
}

// ── 导入导出 ──
function exportBundle() {
  const strip = r => { const { createdAt, updatedAt, ...rest } = r; return rest; };
  return {
    app: "float.xiaojuchang", version: 1, exportedAt: new Date().toISOString(),
    preambles: state.preambles.map(strip), prompts: state.prompts.map(strip), randoms: state.randoms.map(strip),
    macros: state.macros.map(strip), combos: state.combos.map(strip), favorites: state.favorites.map(strip), invalidRecords: clone(state.invalidRecords || {}),
  };
}
function exportCombo(combo) {
  const ids = new Set(combo.promptIds || []);
  return {
    app: "float.xiaojuchang", version: 1, kind: "combo",
    combos: [combo], preambles: state.preambles.filter(p => p.id === combo.preambleId),
    prompts: state.prompts.filter(p => ids.has(p.id)),
    randoms: (combo.random && combo.random.count) ? state.randoms : [],
    macros: state.macros,
  };
}
/** 合并导入：同 id 覆盖，没有的新增。返回条数 */
async function importBundle(data) {
  data = validateBundle(data);
  const idMap = Object.create(null);
  let n = 0;
  const put = async (name, row) => {
    const { id: srcId, ...rest } = row;
    const keep = srcId && state[name].some(x => x.id === srcId);
    const saved = await upsert(name, keep ? { id: srcId, ...rest } : rest);
    if (srcId) idMap[srcId] = saved.id;
    n++;
    return saved;
  };
  const mapCombo = c => ({ ...c, preambleId: idMap[c.preambleId] || c.preambleId, promptIds: (c.promptIds || []).map(id => idMap[id] || id) });
  for (const name of ["preambles", "prompts", "randoms", "macros"]) {
    for (const r of (Array.isArray(data[name]) ? data[name] : [])) { if (r && typeof r === "object") await put(name, r); }
  }
  for (const r of (Array.isArray(data.combos) ? data.combos : [])) { if (r && typeof r === "object") await put("combos", mapCombo(r)); }
  for (const r of (Array.isArray(data.favorites) ? data.favorites : [])) {
    if (!r || typeof r !== "object") continue;
    await put("favorites", {
      ...r, comboId: idMap[r.comboId] || r.comboId || "",
      comboCopy: r.comboCopy ? mapCombo(r.comboCopy) : undefined,
      segments: Array.isArray(r.segments) ? r.segments : [], snapshot: r.snapshot || {},
    });
  }
  return n;
}

/** 暗柜「夜间档案」JSON → 一条场景提示词 + 一条形式提示词 + 一个组合 */
async function importBlackMarketTheater(t) {
  const src = t && t.templateSnapshot ? t.templateSnapshot : t;
  if (!src || !src.aiInstruction) throw new Error("不像暗柜档案：缺少 aiInstruction。");
  const title = String(src.title || "暗柜档案").trim();
  const scene = await upsert("prompts", { title: `${title} · 剧情指令`, tags: ["暗柜", "场景"], content: String(src.aiInstruction) });
  const ids = [scene.id];
  if (src.outputContract) { const form = await upsert("prompts", { title: `${title} · 输出契约`, tags: ["暗柜", "形式"], content: String(src.outputContract) }); ids.push(form.id); }
  const combo = await upsert("combos", {
    name: title, tags: ["暗柜", ...(Array.isArray(src.tags) ? src.tags.slice(0, 4) : [])],
    preambleId: state.preambles[0] ? state.preambles[0].id : "", promptIds: ids,
    random: { count: 0, include: [], exclude: [] },
    output: { mode: "mixed", wrapTag: "", length: "default", customChars: 900, style: "free" },
    memory: { mode: "host", rounds: 12 }, writeBack: false, who: "persona", whoText: "", rawChannel: false, weight: 2, useCount: 0, lastUsedAt: "",
  });
  return combo;
}

async function pickJsonFile() {
  const picked = await api.media.pick({ accept: ".json,application/json" });
  const file = picked && (picked.file || picked);
  const dataUrl = file && (file.dataUrl || file.dataURL);
  if (!dataUrl) throw new Error("没有选到文件。");
  const comma = dataUrl.indexOf(",");
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder("utf-8").decode(bytes);
  return JSON.parse(text);
}
async function saveJsonFile(obj, name) {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; document.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  openSheet("导出文件", box => {
    box.appendChild(el("p", "note-box", "已请求下载 JSON 文件。如果手机没有出现下载，可复制下面的完整内容保存。"));
    const ta = el("textarea", "ta"); ta.value = text; ta.rows = 8; ta.readOnly = true; box.appendChild(ta);
    const copy = el("button", "fab", "复制 JSON"); copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast("已复制 JSON"); }
      catch { ta.focus(); ta.select(); toast("请长按选中的文本复制"); }
    }; box.appendChild(copy);
  });
  return true;
}
