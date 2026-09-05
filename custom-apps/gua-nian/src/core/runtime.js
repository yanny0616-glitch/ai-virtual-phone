  /* ================= 状态 ================= */
  const S = {
    characters: [],
    settings: null,        // db 记录 {id, characterIds, quietStart, quietEnd, quota, …}
    logs: null,            // db 记录 {id, items:[{at,text}]}
    tab: "today",          // today | heart | archive | back
    sub: "diag",           // 后台页里的段：diag | usage
    byId: {},              // 每个挂念的人各一份运行时状态，见 ctxOf
    order: [],             // 挂念的人的顺序（characterId）
    cur: "",               // 面板正在看的那位
  };
  // 每个人各自的今天、计划、好感、注入状态与锁。后台循环拿着各自的 cx 跑，面板只读 cur()
  function ctxOf(ch) {
    return {
      character: ch,       // {id,name,avatar}
      day: null,           // db 记录 {id, date, characterId, mood, moodEmoji, energy, doing, location, schedule[]}
      plan: null,          // db 记录 {id, date, characterId, items:[{time,fireAt,act,why,intent,delivery,reason,wakeId}]}
      prev: null,          // 昨天的 day 记录：今天还没生成时靠它撑过零点到生成之间这段
      aff: null, busy: false, _planLock: false, _ctx: undefined, _gate: null,
      _kitAt: 0, _autoGenDay: "", _rcTry: 0, _gateNoted: 0, _selfNoted: 0,
      archive: null,       // 记录页缓存 {at, dates[], byDate:{date:{day,plan}}, msgs[]}
    };
  }
  const EMPTY_CX = ctxOf(null);
  function cur() { return S.byId[S.cur] || EMPTY_CX; }
  function allCx() { return S.order.map((id) => S.byId[id]).filter(Boolean); }
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = () => GuaNianTime.localDateKey(new Date());
  const fmtHM = GuaNianTime.formatLocalTime;
  const dateStrOf = GuaNianTime.localDateKey;
  const dateOf = (ymd) => GuaNianTime.parseLocalDate(ymd, Date.now());
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function toast(msg) {
    try { AiPhone.ui.toast(msg); return; } catch (e) { /* 沙箱内兜底 */ }
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // 一次编排要写十几条日志，每条都落盘等于把整个 120 条数组重写十几遍。攒到空闲再写一次。
  let logTimer = 0;
  async function log(cx, text) {
    if (cx && cx.character && S.order.length > 1) text = "[" + cx.character.name + "] " + text;
    try {
      if (!S.logs) {
        const rows = await AiPhone.db.list("logs", { limit: 5 });
        S.logs = (rows && rows[0]) || await AiPhone.db.create("logs", { items: [] });
      }
      S.logs.items = (S.logs.items || []).slice(-119);
      S.logs.items.push({ at: Date.now(), text: String(text).slice(0, 300) });
      if (!logTimer) logTimer = setTimeout(flushLogs, 1200);
    } catch (e) { /* 日志失败不打断主流程 */ }
  }

  async function flushLogs() {
    clearTimeout(logTimer);
    logTimer = 0;
    if (!S.logs || !S.logs.id) return;
    // 不拿 update 的返回值覆盖 S.logs：await 期间新写的日志只在内存这份里，覆盖就丢了。
    try { await AiPhone.db.update("logs", S.logs.id, { items: S.logs.items || [] }); }
    catch (e) { /* 日志失败不打断主流程 */ }
  }
