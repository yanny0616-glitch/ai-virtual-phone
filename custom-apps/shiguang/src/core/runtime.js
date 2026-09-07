  /* ================= 运行时：状态、工具 ================= */
  const { safeId } = ShiguangText;
  const { MODES, STATUSES, CATEGORIES } = ShiguangRecall;
  const S = {
    api: null, background: false, launch: null,
    characters: [], characterId: "", settings: null,
    entries: {},        // characterId -> 记录数组（含删除标记）
    progress: {},       // characterId -> 进度行
    tab: "memories", limit: 20, revision: 0, busy: false, editing: null, deleting: null,
  };
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const fmtTime = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "日期未记录"; };
  const errText = err => (err && err.message) || String(err);
  const toast = message => { try { void S.api.ui.toast({ message }); } catch { /* 后台环境没有 UI */ } };
  function character(id) { return S.characters.find(c => c.id === id) || null; }
  function activeEntries(cid) { return (S.entries[cid] || []).filter(ShiguangRecall.isActive); }
  /** 同一角色的写操作排队，避免两个后台事件同时改一张表互相覆盖。 */
  const queues = new Map();
  function serial(key, task) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    queues.set(key, next.catch(() => {}));
    return next;
  }
