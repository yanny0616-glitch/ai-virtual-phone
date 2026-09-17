// ── 声音下载：内置声景按需从 Freesound 拉 128k 高音质预览；商店搜索走 API；都存进宿主媒体库 ──
// 预览地址带 Access-Control-Allow-Origin: *，iframe 里直接 fetch，不经宿主代理，没有体积上限。
const store = (() => {
  const MAX_SECONDS = 240;
  function key() { return (state.settings.freesoundKey || "").trim(); }
  const quality = () => state.settings.soundQuality === "lq" ? "lq" : "hq";
  const QUALITY_LABEL = { hq: "128 kbps 立体声", lq: "64 kbps" };
  const fmtMB = bytes => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

  // 直连拉音频 → dataUrl，带进度
  async function fetchAudio(url, onProgress) {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`下载失败（${res.status}）`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    let blob;
    if (!reader) blob = await res.blob();
    else {
      const chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (onProgress) onProgress(total ? got / total : 0, got); }
      blob = new Blob(chunks, { type: res.headers.get("content-type") || "audio/mpeg" });
    }
    const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("读取失败")); r.readAsDataURL(blob); });
    return { dataUrl, bytes: blob.size };
  }

  async function persistSound(dataUrl, data, epoch) {
    return writeData(async () => {
      const stored = await api.media.put({ dataUrl });
      try {
        if (!dataCurrent(epoch)) throw new Error("下载已取消：数据已清空");
        const row = await api.db.create("library", { ...data, mediaRef: stored.ref });
        state.library.push(row); emit("library"); return row;
      } catch (error) { await api.media.delete({ ref: stored.ref }); throw error; }
    }, epoch);
  }
  const inflight = new Map();
  on("reset", () => inflight.clear());
  // 内置声音：没下过就下，下过直接返回库里的行
  function ensureBuiltin(sound, onProgress) {
    if (resetting) return Promise.reject(new Error("正在清空数据"));
    const epoch = dataEpoch;
    const have = state.library.find(r => r.builtin && r.key === sound.key);
    if (have) return Promise.resolve(have);
    if (inflight.has(sound.key)) return inflight.get(sound.key);
    const job = (async () => {
      const src = SOUND_SOURCES[sound.key];
      const q = quality(); const url = src && (src[q] || src.hq);
      if (!url) throw new Error(`${sound.name} 没有下载地址`);
      const { dataUrl, bytes } = await fetchAudio(url, onProgress);
      return persistSound(dataUrl, { key: sound.key, builtin: true, name: sound.name, source: "freesound", quality: q, author: src.author, url: src.url, bytes }, epoch);
    })().finally(() => { if (inflight.get(sound.key) === job) inflight.delete(sound.key); });
    inflight.set(sound.key, job);
    return job;
  }
  async function ensureAll(keys, onEach) {
    const epoch = dataEpoch;
    const todo = keys.map(findSound).filter(s => s && !s.user && !s.ready);
    for (let i = 0; i < todo.length; i += 1) { if (!dataCurrent(epoch)) throw new Error("下载已取消：数据已清空"); await ensureBuiltin(todo[i], p => onEach && onEach(i, todo.length, p, todo[i])); }
    return todo.length;
  }
  function builtinStats() {
    const rows = state.library.filter(r => r.builtin);
    const q = quality();
    return { ready: rows.length, hq: rows.filter(r => r.quality !== "lq").length, lq: rows.filter(r => r.quality === "lq").length, total: BUILTIN_SOUNDS.length, bytes: rows.reduce((s, r) => s + (r.bytes || 0), 0), allBytes: BUILTIN_SOUNDS.reduce((s, b) => s + ((SOUND_SOURCES[b.key] || {})[q + "Bytes"] || 0), 0), quality: q };
  }

  async function search(query, page = 1) {
    if (!key()) throw new Error("先在「配置」里填 Freesound API Key");
    const params = new URLSearchParams({
      query, page: String(page), page_size: "15", sort: "rating_desc",
      filter: `license:"Creative Commons 0" duration:[10 TO ${MAX_SECONDS}]`,
      fields: "id,name,username,duration,avg_rating,num_ratings,previews,license,url",
    });
    const res = await api.network.fetch({ url: `https://freesound.org/apiv2/search/text/?${params}`, headers: { Authorization: `Token ${key()}` }, timeoutMs: 20000 });
    if (!res.ok) throw new Error(res.status === 401 ? "Key 不对或已失效" : `Freesound 返回 ${res.status}`);
    const json = res.json || JSON.parse(res.text || "{}");
    return { results: json.results || [], next: !!json.next, count: json.count || 0 };
  }
  async function download(item, onProgress) {
    const epoch = dataEpoch;
    const q = quality();
    const url = item.previews && (item.previews[`preview-${q}-mp3`] || item.previews["preview-hq-mp3"] || item.previews["preview-lq-mp3"]);
    if (!url) throw new Error("这条没有预览音频");
    const { dataUrl, bytes } = await fetchAudio(url, onProgress);
    return persistSound(dataUrl, {
      key: `fs_${item.id}`, name: item.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 24), icon: "headphones", source: "freesound", quality: q,
      author: item.username, license: item.license, url: item.url, duration: Math.round(item.duration), bytes,
    }, epoch);
  }
  async function importFile() {
    const epoch = dataEpoch;
    const picked = await api.media.pick({ accept: "audio/*" });
    if (!picked || !picked.file || !picked.file.dataUrl) return null;
    const name = (picked.file.name || "我的录音").replace(/\.[a-z0-9]+$/i, "").slice(0, 24);
    return persistSound(picked.file.dataUrl, { key: `my_${Date.now().toString(36)}`, name, icon: "mic", source: "import" }, epoch);
  }
  async function remove(row) {
    if (row.mediaRef) { try { await api.media.delete({ ref: row.mediaRef }); } catch { /* ignore */ } }
    await api.db.delete("library", row.id);
    state.library = state.library.filter(r => r.id !== row.id);
    engine.forget(row.key);
    emit("library");
  }
  async function removeBuiltins() {
    for (const row of state.library.filter(r => r.builtin)) await remove(row);
  }
  return { search, download, importFile, remove, removeBuiltins, ensureBuiltin, ensureAll, builtinStats, fetchAudio, fmtMB, quality, QUALITY_LABEL, MAX_SECONDS };
})();
