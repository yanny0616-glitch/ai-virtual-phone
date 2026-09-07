  /* ================= 存储：宿主 APP 数据库 ================= */
  const SETTINGS_DEFAULT = { enabled: true, autoEnabled: true, roundInterval: 20, tokenBudget: 800, migrated: {} };
  const col = cid => "mem_" + safeId(cid);

  async function loadSettings() {
    if (S.settings) return S.settings;
    const rows = await S.api.db.list("settings", { limit: 5 });
    S.settings = (rows && rows[0]) || await S.api.db.create("settings", { ...SETTINGS_DEFAULT });
    const missing = {};
    for (const key in SETTINGS_DEFAULT) if (S.settings[key] == null) missing[key] = SETTINGS_DEFAULT[key];
    if (Object.keys(missing).length) S.settings = await S.api.db.update("settings", S.settings.id, missing);
    return S.settings;
  }
  function patchSettings(patch) {
    return serial("settings", async () => { S.settings = await S.api.db.update("settings", S.settings.id, patch); return S.settings; });
  }

  async function loadEntries(cid) {
    const rows = await S.api.db.list(col(cid), { limit: 500 });
    S.entries[cid] = (rows || []).filter(r => r && typeof r.title === "string");
    return S.entries[cid];
  }
  async function loadProgress(cid) {
    const row = await S.api.db.get("progress", safeId(cid));
    S.progress[cid] = row || null;
    return row;
  }
  async function saveProgress(cid, patch) {
    const current = S.progress[cid] || await loadProgress(cid);
    S.progress[cid] = current
      ? await S.api.db.update("progress", current.id, patch)
      : await S.api.db.create("progress", { id: safeId(cid), characterId: cid, ...patch });
    return S.progress[cid];
  }

  /** 写一条记录：有 baseUpdatedAt 就要求库里版本一致，防止后台整理覆盖用户手改、或旧编辑框覆盖新内容。 */
  async function putEntry(cid, entry) {
    const { baseUpdatedAt, ...row } = entry;
    const list = S.entries[cid] || await loadEntries(cid);
    const current = list.find(e => e.id === row.id);
    if (current) {
      const live = await S.api.db.get(col(cid), row.id);
      if (baseUpdatedAt !== undefined && live && live.updatedAt !== baseUpdatedAt) throw new Error("这条记忆已变化，请刷新后重新编辑；本次没有覆盖它");
      if (live && live.deletedAt && !row.deletedAt) return null;
      const saved = await S.api.db.update(col(cid), row.id, row);
      S.entries[cid] = list.map(e => e.id === row.id ? saved : e);
      return saved;
    }
    const saved = await S.api.db.create(col(cid), row);
    S.entries[cid] = [...list, saved];
    return saved;
  }
