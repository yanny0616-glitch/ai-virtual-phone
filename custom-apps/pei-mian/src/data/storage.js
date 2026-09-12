// ── 存储：settings 一行、nights 每晚一行、mixes 每个组合一行、library 用户自己加的声音每个一行 ──
const DEFAULT_SETTINGS = Object.freeze({
  theme: "auto", autoBy: "system", characterId: "", ttsOn: true, sttOn: true, emotion: "calm",
  timerMin: 45, fadeMin: 5, syncChat: true, morningOn: true, freesoundKey: "", soundQuality: "hq", pinnedPresets: null,
  goal: { bedtime: "23:30", hours: 7.5 },
  rhythmPreset: "gentle", rhythm: null, directions: ["today", "scene"], forbid: "",
  insomniaDirections: ["breath", "trivia"], insomniaForbid: "",
  currentMix: { name: "", layers: [], master: 0.7 }, dimLevel: 0,
});

async function loadSettings() {
  const rows = await api.db.list("settings", { limit: 5 });
  const row = rows && rows[0];
  const merged = { ...DEFAULT_SETTINGS, ...(row || {}) };
  merged.goal = { ...DEFAULT_SETTINGS.goal, ...(merged.goal || {}) };
  merged.currentMix = { ...DEFAULT_SETTINGS.currentMix, ...(merged.currentMix || {}) };
  if (!row) { const created = await api.db.create("settings", { ...DEFAULT_SETTINGS }); merged.id = created.id; }
  state.settings = merged;
  return merged;
}
let saveTimer = 0;
function saveSettings(patch) {
  Object.assign(state.settings, patch || {});
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { id, ...data } = state.settings;
      await api.db.update("settings", id, data);
    } catch (e) { fail(e); }
  }, 250);
}

async function loadNights() {
  const rows = await api.db.list("nights", { limit: 500 });
  state.nights = (rows || []).filter(n => n && n.date).sort((a, b) => (a.date < b.date ? 1 : -1));
  return state.nights;
}
async function upsertNight(night) {
  if (night.id) { await api.db.update("nights", night.id, night); }
  else { const created = await api.db.create("nights", night); night.id = created.id; }
  const idx = state.nights.findIndex(n => n.id === night.id);
  if (idx >= 0) state.nights[idx] = night; else state.nights.unshift(night);
  state.nights.sort((a, b) => (a.date < b.date ? 1 : -1));
  emit("nights");
  return night;
}
async function loadMixes() { state.mixes = (await api.db.list("mixes", { limit: 100 })) || []; return state.mixes; }
async function loadLibrary() { state.library = (await api.db.list("library", { limit: 200 })) || []; return state.library; }

async function resetAll() {
  for (const table of ["nights", "mixes", "library"]) {
    const rows = await api.db.list(table, { limit: 500 });
    for (const row of rows || []) {
      if (row.mediaRef) { try { await api.media.delete({ ref: row.mediaRef }); } catch { /* ignore */ } }
      await api.db.delete(table, row.id);
    }
  }
  const { id } = state.settings;
  await api.db.update("settings", id, { ...DEFAULT_SETTINGS });
  state.settings = { ...DEFAULT_SETTINGS, id };
  state.nights = []; state.mixes = []; state.library = [];
}
