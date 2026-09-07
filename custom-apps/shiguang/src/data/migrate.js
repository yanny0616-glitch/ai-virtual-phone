  /* ================= 接续旧记录 ================= */
  // 2.0 之前拾光存在宿主记忆库里。宿主还留着一个只读接口，第一次打开时按角色搬进 APP 自己的表。
  // 搬完把水位设在当下：旧记录已经覆盖了之前的聊天，不再重整一遍。
  function fromLegacy(entry) {
    const d = entry.shiguang || {};
    return {
      id: "sg_" + ShiguangText.hash(entry.id), characterId: entry.characterId,
      title: d.title || "", summary: entry.content || "", categories: d.categories || [],
      reason: d.reason || "", story: d.story || "", details: d.details || [], significance: d.significance || "",
      promptSummary: (d.promptSummary || "").trim(), recallMode: d.recallMode || (d.stableSummary ? "priority" : "relevant"),
      keywords: d.keywords || [], status: d.status || "remembered", dueAt: d.dueAt, followup: d.followup || "",
      firstEventAt: d.firstEventAt || entry.createdAt, lastEventAt: d.lastEventAt || entry.updatedAt,
      sourceIds: entry.sourceMessageIds || [], userEdited: !!d.userEdited, deletedAt: d.deletedAt,
      legacy: { stableSummary: d.stableSummary || "", recallSummary: d.recallSummary || "" },
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, legacyId: entry.id,
    };
  }
  async function migrateCharacter(cid) {
    const settings = await loadSettings();
    if (settings.migrated && settings.migrated[cid]) return 0;
    let imported = 0;
    if (S.api.memory && typeof S.api.memory.readShiguang === "function") {
      let legacy = null;
      try { legacy = await S.api.memory.readShiguang({ characterId: cid }); } catch { legacy = null; }
      if (legacy && Array.isArray(legacy.entries)) {
        const existing = S.entries[cid] || await loadEntries(cid);
        for (const item of legacy.entries) {
          const row = fromLegacy(item);
          if (!row.title || existing.some(e => e.id === row.id)) continue;
          await putEntry(cid, row); imported++;
        }
      }
    }
    const progress = S.progress[cid] || await loadProgress(cid);
    if (!progress || !progress.watermarkAt) await saveProgress(cid, { watermarkAt: new Date().toISOString(), watermarkId: "" });
    await patchSettings({ migrated: { ...(S.settings.migrated || {}), [cid]: true } });
    return imported;
  }
