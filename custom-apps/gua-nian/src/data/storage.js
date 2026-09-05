  async function loadSettings() {
    const rows = await AiPhone.db.list("settings", { limit: 5 });
    S.settings = (rows && rows[0]) || await AiPhone.db.create("settings", { characterId: "", ...SET_DEF });
    const missing = {};
    for (const k in SET_DEF) if (S.settings[k] == null) missing[k] = SET_DEF[k];
    // 0.9.9 起默认随用随判，它唯一的出念路径是自发起念；老设置里 selfImpulseCap 还是旧默认 2 或干脆关着，不抬上去会一整天没动静
    if (S.settings.impulseMode == null && !(S.settings.selfImpulseCap >= SET_DEF.selfImpulseCap)) missing.selfImpulseCap = SET_DEF.selfImpulseCap;
    // 0.9.1 之前只挂念一个人：单个 characterId / sentinel / genTpl 折进按角色的表
    const legacyId = S.settings.characterId;
    if (!(Array.isArray(S.settings.characterIds) && S.settings.characterIds.length) && legacyId) missing.characterIds = [legacyId];
    if (S.settings.sentinel && S.settings.sentinel.wakeId && S.settings.sentinel.characterId) {
      missing.sentinels = Object.assign({}, S.settings.sentinels, { [S.settings.sentinel.characterId]: { wakeId: S.settings.sentinel.wakeId, armed: !!S.settings.sentinel.armed } });
      missing.sentinel = null;
    }
    if (S.settings.genTpl && S.settings.genTpl.characterId) {
      missing.genTpls = Object.assign({}, S.settings.genTpls, { [S.settings.genTpl.characterId]: S.settings.genTpl });
      missing.genTpl = null;
    }
    // 本机 id 只生成一次：换浏览器或清了应用数据就是另一台设备，靠横幅上的「改用这台」找回来
    if (!S.settings.deviceId) {
      missing.deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      missing.deviceName = guessDeviceName();
    }
    if (Object.keys(missing).length) S.settings = await AiPhone.db.update("settings", S.settings.id, missing);
  }
  // 设备名只给自己看：横幅上要写「今天由『手机 Safari』负责」，光一串随机 id 认不出是哪台
  function guessDeviceName() {
    const ua = navigator.userAgent || "";
    const plat = /iPhone|iPod/.test(ua) ? "手机" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "安卓机"
      : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "电脑" : "设备";
    const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox"
      : /Safari/.test(ua) ? "Safari" : "";
    return br ? plat + " " + br : plat;
  }
  // settings 是一行整体覆盖写：两个人同时冻模板/换哨兵，各自拿内存里的旧字典改一格再写回，
  // 后写的把先写的那格盖掉，丢的哨兵 id 从此撤不掉。所有后台写都排队，写时再取最新值。
  let _settingsQ = Promise.resolve();
  function patchSettings(fn) {
    const run = async () => { S.settings = await AiPhone.db.update("settings", S.settings.id, fn(S.settings)); return S.settings; };
    const p = _settingsQ.then(run, run);
    _settingsQ = p.catch(() => { /* 失败不卡住后面的写 */ });
    return p;
  }
  async function loadDayAndPlan(cx) {
    const date = todayStr(), cid = cx.character.id;
    const days = await AiPhone.db.list("days", { limit: 60 });
    cx.day = (days || []).find((r) => r.date === date && r.characterId === cid) || null;
    const yd = dateOf(date); yd.setDate(yd.getDate() - 1);
    cx.prev = (days || []).find((r) => r.date === dateStrOf(yd) && r.characterId === cid) || null;
    const plans = await AiPhone.db.list("plans", { limit: 60 });
    cx.plan = (plans || []).find((r) => r.date === date && r.characterId === cid) || null;
    const th = await AiPhone.db.list("threads", { limit: 60 });
    const row = (th || []).find((r) => r.characterId === cid);
    cx.threads = row && Array.isArray(row.items) ? row.items : [];
  }
