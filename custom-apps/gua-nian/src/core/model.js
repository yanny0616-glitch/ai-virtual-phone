  /* ================= 工具 ================= */
  function parseModelJson(text) {
    let t = String(text || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "") // 思考型模型的思维链段落
      .replace(/```(?:json)?/gi, "")
      .trim();
    try { return JSON.parse(t); } catch (e) { /* 继续尝试截取 */ }
    // 从每一个 { 开始试着配平括号截取（模型前后夹了废话时也能捞出 JSON）
    for (let a = t.indexOf("{"); a >= 0; a = t.indexOf("{", a + 1)) {
      let depth = 0, inStr = false, escaped = false;
      for (let i = a; i < t.length; i++) {
        const ch = t[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          try { return JSON.parse(t.slice(a, i + 1)); } catch (e) { break; }
        }
      }
    }
    // 把模型实际说了什么带进错误里，日志可查
    throw new Error("模型没回 JSON，它说的是：「" + t.slice(0, 100) + (t.length > 100 ? "…" : "") + "」");
  }
  // 模型没按要求回 JSON 时（比如回了一段普通话），带更严的指令重试一次
  /* ================= 模型调用用量：本机（宿主统计）+ 云端（push_api_usage） ================= */
  const USAGE_SRC = "custom_app:gua.nian";
  const USAGE_LABEL = { app: "本机（旧记录）", "cloud-gen": "云端生成一天", "cloud-recheck": "云端复核", "cloud-wake": "云端到点发送", "cloud-chat": "聊天离线兜底（不计上限）" };
  // 云端账本按 (天, 来源) 存绝对值，整行覆盖。两台设备都报 source="app" 就会互相把对方的数清掉，
  // 合计和日上限跟着失真。所以本机那行的来源带上设备 id：各占一行，云函数照旧把当天所有行相加。
  function myUsageSrc() { return "app-" + myDev(); }
  function isDeviceSrc(src) { return /^app(-|$)/.test(String(src || "")); }
  function usageLabel(src) {
    if (src === myUsageSrc()) return "本机（" + myDevName() + "）";
    if (isDeviceSrc(src) && src !== "app") return "另一台设备";
    return USAGE_LABEL[src] || src;
  }
  function apiUseToday() {
    const u = S.settings && S.settings.apiUse;
    return u && u.date === todayStr() ? u : { date: todayStr(), n: 0 };
  }
  // 本机今天的用量：宿主按来源统计（含 token）；宿主还没记上时用本地计数兜底
  async function readLocalUsage(force) {
    if (!force && S._useLocal && Date.now() - S._useLocal.at < 60000) return S._useLocal;
    const out = { at: Date.now(), calls: apiUseToday().n, prompt: 0, completion: 0, days: [] };
    try {
      if (AiPhone.usage && AiPhone.usage.readDaily) {
        const r = await AiPhone.usage.readDaily({ days: 7 });
        out.days = (r && r.days || []).map((d) => {
          const b = (d.bySource || {})[USAGE_SRC] || { calls: 0, promptTokens: 0, completionTokens: 0 };
          return { date: d.date, calls: +b.calls || 0, prompt: +b.promptTokens || 0, completion: +b.completionTokens || 0 };
        });
        const td = out.days.find((d) => d.date === todayStr());
        if (td) { out.calls = Math.max(out.calls, td.calls); out.prompt = td.prompt; out.completion = td.completion; }
      }
    } catch (e) { /* 没有 usage.read 权限或旧宿主：只有次数 */ }
    S._useLocal = out;
    return out;
  }
  // 云端账本：上报本机今天的用量和上限，再把最近几天各来源拉回来
  async function syncUsageCloud(force) {
    if (!cloudCfg()) return null;
    if (!force && S._use && Date.now() - S._use.at < 5 * 60000) return S._use;
    const local = await readLocalUsage(force);
    try {
      // 0.9.6 之前本机那行统一叫 "app"。留着它会和新的 app-<设备> 行一起被云端上限
      // 重复计一遍，所以每次启动清零一次（清不掉就最多多算今天这一天）。
      if (!S._legacyZeroed) {
        S._legacyZeroed = true;
        try { await cloudFetch("usage", { method: "POST", body: JSON.stringify({ set: { day: todayStr(), source: "app", calls: 0, promptTokens: 0, completionTokens: 0 } }) }); }
        catch (e) { /* 旧云函数没有 usage 动作，下面那次 POST 会一起报错 */ }
      }
      await cloudFetch("usage", { method: "POST", body: JSON.stringify({
        limits: { dailyCalls: +S.settings.apiDailyCap || 0, dailyTokens: +S.settings.tokenDailyCap || 0, tz: -new Date().getTimezoneOffset() },
        set: { day: todayStr(), source: myUsageSrc(), calls: local.calls, promptTokens: local.prompt, completionTokens: local.completion },
      }) });
      const r = await cloudFetch("usage", { method: "GET" }, { days: 7 });
      S._use = { at: Date.now(), rows: Array.isArray(r.rows) ? r.rows : [], limits: r.limits || null };
    } catch (e) {
      if (!S._useWarned) { S._useWarned = true; await log(cur(), "云端用量账本读写失败（旧版云函数没有 usage 动作，重部署一次即可）：" + (e && e.message || e)); }
      S._use = S._use || { at: Date.now(), rows: [], limits: null };
    }
    return S._use;
  }
  // 今天合计：本机用最新的本地数（自己那行是自己报的，不从账本里再算一遍），
  // 云端各来源和另一台设备的本机数都用账本里的。旧的 "app" 行已清零，一律不算。
  function usageTotals() {
    const local = S._useLocal || { calls: apiUseToday().n, prompt: 0, completion: 0 };
    const mine = myUsageSrc();
    const rows = ((S._use && S._use.rows) || []).filter((r) => r.day === todayStr() && r.source !== mine && r.source !== "app");
    let cloudCalls = 0, cloudTokens = 0, otherCalls = 0, otherTokens = 0, capCalls = 0, capTokens = 0;
    for (const r of rows) {
      const t = (+r.prompt_tokens || 0) + (+r.completion_tokens || 0);
      if (isDeviceSrc(r.source)) { otherCalls += +r.calls || 0; otherTokens += t; }
      else { cloudCalls += +r.calls || 0; cloudTokens += t; }
      if (r.source !== "cloud-chat") { capCalls += +r.calls || 0; capTokens += t; }
    }
    const localCalls = Math.max(local.calls, apiUseToday().n), localTokens = local.prompt + local.completion;
    return { localCalls, localTokens, cloudCalls, cloudTokens, otherCalls, otherTokens, rows,
      calls: localCalls + capCalls, tokens: localTokens + capTokens,
      capCalls: +S.settings.apiDailyCap || 0, capTokens: +S.settings.tokenDailyCap || 0 };
  }
  function usageOver() {
    const t = usageTotals();
    if (t.capCalls > 0 && t.calls >= t.capCalls) return "今天的模型调用次数用完了（" + t.calls + "/" + t.capCalls + "），明天再来，或去设置里调高";
    if (t.capTokens > 0 && t.tokens >= t.capTokens) return "今天的 token 额度用完了（" + fmtTok(t.tokens) + "/" + fmtTok(t.capTokens) + "），明天再来，或去设置里调高";
    return "";
  }
  const fmtTok = (n) => n >= 1000000 ? (n / 1000000).toFixed(2) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0);
  async function spendApi(cx) {
    await readLocalUsage(false);
    const over = usageOver();
    if (over) throw new Error(over);
    S.settings.apiUse = { date: todayStr(), n: apiUseToday().n + 1 };
    if (S._useLocal) S._useLocal.calls = Math.max(S._useLocal.calls, S.settings.apiUse.n);
    try { await patchSettings((s) => ({ apiUse: s.apiUse })); } catch (e) { /* 记不上也不拦 */ }
    // 宿主的用量统计在回复落库后才更新：过几秒再读一次并上报云端
    clearTimeout(S._useTimer);
    S._useTimer = setTimeout(() => { readLocalUsage(true).then(() => syncUsageCloud(true)).catch(() => { /* 已记日志 */ }); }, 8000);
  }
  async function generateJson(cx, req) {
    await spendApi(cx);
    const r = await AiPhone.ai.generate(req);
    try { return parseModelJson(r.text); } catch (e) {
      await log(cx, "首次生成未得到 JSON（" + (e && e.message || e) + "），追加严格指令重试");
      await spendApi(cx);
      const r2 = await AiPhone.ai.generate({
        ...req,
        instruction: req.instruction + "\n\n重要：只输出 JSON 本身，第一个字符必须是 {，最后一个字符必须是 }，不要任何解释、前言、思考过程或代码块标记。",
      });
      return parseModelJson(r2.text);
    }
  }
  // 模型字段名跑偏（中文键名/别名）时按候选键顺序捞
  function pickField(o, keys) {
    for (const k of keys) {
      if (o && o[k] != null && String(o[k]).trim() !== "") return o[k];
    }
    return "";
  }
  // 「8:30」「08：30」「8点30」「14时」等都归一成 HH:MM；认不出返回空串
  function isTrue(v) { return v === true || /^(true|是|1)$/i.test(String(v || "").trim()); }
  const normHM = GuaNianTime.normalizeTime;
  function timeToMs(hm, base) {
    return GuaNianTime.timeOnLocalDay(hm, base || Date.now());
  }
