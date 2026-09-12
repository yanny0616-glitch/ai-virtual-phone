// ── 声音商店：Freesound API（CC0），搜索走浏览器直连，下载走宿主代理拿二进制 ──
const store = (() => {
  const MAX_SECONDS = 170; // 64k 预览 ≈ 8KB/s，宿主代理二进制上限约 1.5MB
  function key() { return (state.settings.freesoundKey || "").trim(); }
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
  async function download(item) {
    const url = item.previews && item.previews["preview-lq-mp3"];
    if (!url) throw new Error("这条没有预览音频");
    const res = await api.network.fetch({ url, proxy: true, timeoutMs: 90000 });
    if (!res.ok || !res.binary || !res.data) throw new Error("下载失败，可能超过体积上限");
    const dataUrl = `data:${res.contentType || "audio/mpeg"};base64,${res.data}`;
    const stored = await api.media.put({ dataUrl });
    const row = await api.db.create("library", {
      key: `fs_${item.id}`, name: item.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 24), icon: "headphones", source: "freesound",
      author: item.username, license: item.license, url: item.url, duration: Math.round(item.duration), mediaRef: stored.ref,
    });
    state.library.push(row);
    return row;
  }
  async function importFile() {
    const picked = await api.media.pick({ accept: "audio/*" });
    if (!picked || !picked.file || !picked.file.dataUrl) return null;
    const stored = await api.media.put({ dataUrl: picked.file.dataUrl });
    const name = (picked.file.name || "我的录音").replace(/\.[a-z0-9]+$/i, "").slice(0, 24);
    const row = await api.db.create("library", { key: `my_${Date.now().toString(36)}`, name, icon: "mic", source: "import", mediaRef: stored.ref });
    state.library.push(row);
    return row;
  }
  async function remove(row) {
    if (row.mediaRef) { try { await api.media.delete({ ref: row.mediaRef }); } catch { /* ignore */ } }
    await api.db.delete("library", row.id);
    state.library = state.library.filter(r => r.id !== row.id);
    engine.forget(row.key);
  }
  return { search, download, importFile, remove, MAX_SECONDS };
})();
