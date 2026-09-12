// ── 存储：settings 一行、nights 每晚一行、mixes 每个组合一行、library 用户自己加的声音每个一行 ──
const DEFAULT_SETTINGS = Object.freeze({
  theme: "auto", autoBy: "system", characterId: "", ttsOn: true, sttOn: true, emotion: "calm",
  timerMin: 45, fadeMin: 5, syncChat: true, morningOn: true, freesoundKey: "", soundQuality: "hq", pinnedPresets: null,
  goal: { bedtime: "23:30", hours: 7.5 },
  rhythmPreset: "gentle", rhythm: null, directions: ["today", "scene"], forbid: "",
  insomniaDirections: ["breath", "trivia"], insomniaForbid: "",
  currentMix: { name: "", layers: [], master: 0.7 }, dimLevel: 0,
});

const freshSettings = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let dataEpoch = 0;
let resetting = false;
let resetPromise = null;
let writeQueue = Promise.resolve();
function writeData(task, epoch = dataEpoch) {
  const job = writeQueue.then(() => {
    if (resetting || epoch !== dataEpoch) throw new Error("操作已取消：数据正在清空或已重置");
    return task();
  });
  writeQueue = job.catch(() => {});
  return job;
}
const dataCurrent = epoch => !resetting && epoch === dataEpoch;

async function loadSettings() {
  const rows = await api.db.list("settings", { limit: 5 });
  const row = rows && rows[0];
  const defaults = freshSettings();
  const merged = { ...defaults, ...(row || {}) };
  merged.goal = { ...defaults.goal, ...(merged.goal || {}) };
  merged.currentMix = { ...defaults.currentMix, ...(merged.currentMix || {}) };
  const seen = new Set();
  merged.currentMix.layers = (Array.isArray(merged.currentMix.layers) ? merged.currentMix.layers : [])
    .filter(l => l && l.key && !seen.has(l.key) && seen.add(l.key)).slice(0, PmMixer.MAX_LAYERS)
    .map(l => ({ ...l }));
  if (!row) { const created = await api.db.create("settings", freshSettings()); merged.id = created.id; }
  state.settings = merged;
  return merged;
}
let saveTimer = 0;
function saveSettings(patch) {
  if (resetting) return;
  Object.assign(state.settings, patch || {});
  clearTimeout(saveTimer);
  const epoch = dataEpoch;
  saveTimer = setTimeout(async () => {
    try {
      const { id, ...data } = state.settings;
      await writeData(() => api.db.update("settings", id, JSON.parse(JSON.stringify(data))), epoch);
    } catch (e) { fail(e); }
  }, 250);
}

async function loadNights() {
  const rows = await api.db.list("nights", { limit: 500 });
  state.nights = PmStats.uniqueNights(rows || []);
  return state.nights;
}
async function upsertNight(night, epoch = dataEpoch) {
  return writeData(async () => {
    const existing = state.nights.find(n => n.date === night.date);
    const data = { ...night, ...(existing?.id ? { id: existing.id } : {}) };
    const saved = data.id ? await api.db.update("nights", data.id, data) : await api.db.create("nights", data);
    if (!saved?.id) throw new Error("夜记没有保存成功，请重试");
    Object.assign(night, data, { id: saved.id });
    state.nights = PmStats.uniqueNights([night, ...state.nights.filter(n => n.date !== night.date)]);
    emit("nights");
    return night;
  }, epoch);
}
async function loadMixes() { state.mixes = (await api.db.list("mixes", { limit: 100 })) || []; return state.mixes; }
async function loadLibrary() { state.library = (await api.db.list("library", { limit: 200 })) || []; return state.library; }

async function resetAll() {
  if (resetPromise) return resetPromise;
  resetting = true; dataEpoch += 1; clearTimeout(saveTimer);
  resetPromise = (async () => {
    await writeQueue;
    // db.list 最多返回500行：每次删除当前批次，再从头取下一批。
    for (const table of ["nights", "mixes", "library", "settings"]) {
      for (;;) {
        const rows = await api.db.list(table, { limit: 500 });
        if (!rows?.length) break;
        for (const row of rows) {
          if (row.mediaRef) await api.media.delete({ ref: row.mediaRef });
          await api.db.delete(table, row.id);
        }
        const remaining = await api.db.list(table, { limit: 1 });
        if (remaining?.some(r => rows.some(old => old.id === r.id))) throw new Error("数据未删除，请重试清空");
      }
    }
    const created = await api.db.create("settings", freshSettings());
    state.settings = { ...freshSettings(), id: created.id };
    state.nights = []; state.mixes = []; state.library = [];
    state.timerMin = state.settings.timerMin;
    emit("reset");
  })();
  try { await resetPromise; } finally { resetting = false; resetPromise = null; }
}
