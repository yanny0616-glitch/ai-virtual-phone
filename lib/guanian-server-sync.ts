// 挂念交给 VPS 后端（设置里开了 serverBrain）时，小手机这边要做的事。小手机开着就跑，挂念 App 不用开：
//   · 从后端取 TA此刻的状态：在线状态变量、回复闸门、注入聊天提示词、朋友圈节奏变量
//   · 后端起意的朋友圈在前台补成帖子，回执寄回后端
//   · 后端生成的日程写回系统日程表
//   · 把后端看不到的原料寄过去：好感、系统日程表上的安排、「忙碌回复」插件的固定作息和例外
// 鉴权用「云服务部署」里的个人云 Secret key；后端拿它去个人云核对。
import { loadInstalledCustomApps, readCustomAppCollection, CUSTOM_APPS_UPDATED_EVENT, CUSTOM_APP_DATA_UPDATED_EVENT } from './custom-app-storage';
import { getChatPluginVar, setChatPluginVar, unsetChatPluginVar, CHAT_PLUGIN_VARS_CHANGED_EVENT } from './chat-plugin-storage';
import { normalizeReplyGate, setCustomAppReplyGate } from './chat-reply-gate';
import { clearCustomAppChatContext, setCustomAppChatContext } from './custom-app-chat-context';
import { postCustomAppMoment, readCustomAppCalendar, writeCustomAppCalendar } from './custom-app-host-api';
import { calculateGuanianPresence, guanianPresenceGate, presenceDate, type PresenceDay } from './guanian-presence';
import { kvGet, kvSet, registerKvMigration } from './kv-db';
import { companionServerUrl, personalCloudCredentials } from './offline-executor';

const SOURCE = 'guanian-server';
const CALENDAR_KEY = 'guanian_server_calendar_v1';
registerKvMigration(CALENDAR_KEY);
const NET_MS = 60_000;

type Target = { appId: string; appName: string; characterId: string; settings: Record<string, unknown> };
type ServerDay = PresenceDay & { date?: string; schedule?: { time?: string; end?: string; title?: string }[] };
type HostCharacter = {
  characterId: string; exists: boolean; enabled: boolean; error?: string; date?: string;
  day?: ServerDay | null; prev?: ServerDay | null; context?: string; contextAt?: string;
  settings?: { quietStart?: string; quietEnd?: string; momentsOn?: unknown; momentsWeekly?: unknown; momentsGapH?: unknown; momentsLast?: unknown; momentsWeekN?: unknown };
  moments?: { id: string; hint: string; at?: number }[];
};

let stopCurrent: (() => void) | null = null;

// 地址和钥匙只看小手机「离线推送 → 离线执行」和「云服务部署」，挂念自己不再存
export function guanianServerConfig(_settings?: Record<string, unknown>) {
  return { url: companionServerUrl(), key: personalCloudCredentials().key };
}

const addMin = (hm: string, n: number) => {
  const m = ((+hm.slice(0, 2) * 60 + +hm.slice(3, 5) + n) % 1440 + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function startGuanianServerSync(): () => void {
  stopCurrent?.();
  let disposed = false, running = false, again = false, lastNet = 0, varTimer = 0;
  const latest = new Map<string, { at: number; h: HostCharacter; t: Target }>();
  const managed = new Map<string, string>();
  const gateSignatures = new Map<string, string>();
  const contextSignatures = new Map<string, { text: string; at: number }>();
  const inputSignatures = new Map<string, { sig: string; at: number }>();
  const posting = new Set<string>();
  let publishing = false;
  let calendarSignatures: Record<string, string> = {};
  try { calendarSignatures = JSON.parse(kvGet(CALENDAR_KEY) || '{}') || {}; } catch { calendarSignatures = {}; }

  function listed(): Map<string, string> {
    const all = new Map<string, string>();
    for (const app of loadInstalledCustomApps()) {
      if (app.manifest.id !== 'gua.nian') continue;
      const settings = readCustomAppCollection(app.id, 'settings')[0];
      const ids = settings && Array.isArray(settings.characterIds) ? settings.characterIds : [];
      for (const id of ids) if (typeof id === 'string' && id) all.set(id, app.id);
    }
    return all;
  }
  function targets(): Target[] {
    const result = new Map<string, Target>();
    for (const app of loadInstalledCustomApps()) {
      if (app.manifest.id !== 'gua.nian') continue;
      const settings = readCustomAppCollection(app.id, 'settings')[0];
      if (!settings || !settings.serverBrain || !guanianServerConfig(settings).key) continue;
      const ids = Array.isArray(settings.characterIds) ? settings.characterIds : [settings.characterId];
      for (const id of ids) {
        if (typeof id === 'string' && id) result.set(id, { appId: app.id, appName: app.manifest.name || '挂念', characterId: id, settings });
      }
    }
    return [...result.values()];
  }

  async function api(t: Target, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const { url, key } = guanianServerConfig(t.settings);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
      if (init.body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url + path, { ...init, headers, cache: 'no-store', signal: controller.signal });
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!res.ok || !data || data.ok !== true) throw new Error(String(data?.error || `HTTP ${res.status}`));
      return data;
    } finally { window.clearTimeout(timer); }
  }
  const characterPath = (t: Target, tail: string) => `/app/characters/${encodeURIComponent(t.characterId)}${tail}`;

  // 挂念里不再挂念的人：撤掉这边写的状态。挂念只是关了后端模式的话留给 App 自己覆盖
  function release(active: Target[]) {
    const keep = new Set(active.map(t => t.characterId));
    const still = listed();
    for (const [cid, appId] of managed) {
      if (keep.has(cid)) continue;
      managed.delete(cid); gateSignatures.delete(cid); contextSignatures.delete(cid); latest.delete(cid);
      if (still.has(cid)) continue;
      const p = getChatPluginVar('presence', 'character', cid) as Record<string, unknown> | null;
      if (p?.managedBy === SOURCE) unsetChatPluginVar('presence', 'character', cid);
      setCustomAppReplyGate(appId, cid, null);
      clearCustomAppChatContext(appId, cid);
    }
  }

  function publish(t: Target, h: HostCharacter, fetchedAt: number, stale: boolean) {
    const now = Date.now(), cid = t.characterId;
    const day = h.day || null, prev = h.prev || null;
    const settings = { quietStart: h.settings?.quietStart, quietEnd: h.settings?.quietEnd };
    publishing = true;
    try {
      const value = calculateGuanianPresence(day, prev, settings, now);
      const presence = {
        ...(value || { at: now, state: 'away', label: '状态待同步', doing: '', asleep: false, busy: false }),
        managedBy: SOURCE, appId: t.appId, syncStatus: stale ? 'cached' : 'synced', syncAt: fetchedAt,
      };
      const old = getChatPluginVar('presence', 'character', cid) as Record<string, unknown> | null;
      const comparable = (p: Record<string, unknown> | null) => { const v = { ...p }; delete v.at; return JSON.stringify(v); };
      if (comparable(old) !== comparable(presence) || now - Number(old?.at || 0) >= 60_000) setChatPluginVar('presence', presence, 'character', cid);

      const availability = guanianPresenceGate(day, prev, settings, now);
      const st = t.settings;
      const raw = availability ? { ...availability, legacyReplySettings: {
        enabled: st.replyGate !== false, adaptive: st.smartBusyReply !== false, peekMin: st.busyPeekMin ?? 3,
        focusedPeekProb: st.focusedPeekProb ?? 25, sleepMode: st.sleepMode === 2 ? 'chance' : 'wait',
        wakeProb: st.sleepWakeProb ?? 18, wakeBufferMin: st.busyBufferMin ?? 10,
      } } : null;
      const sig = JSON.stringify(raw ? { ...raw, updatedAt: 0 } : null);
      if (gateSignatures.get(cid) !== sig) { setCustomAppReplyGate(t.appId, cid, normalizeReplyGate(raw)); gateSignatures.set(cid, sig); }

      // 注入聊天：文字变了才写；没变也每 15 分钟重写一次，让标题上的时刻不显得旧
      const text = t.settings.injectChat === false ? '' : String(h.context || '');
      const prior = contextSignatures.get(cid);
      if (!prior || prior.text !== text || (text && now - prior.at >= 15 * 60_000)) {
        setCustomAppChatContext(t.appId, t.appName, { characterId: cid, label: text ? `${h.contextAt || ''} 的状态`.trim() : '', text });
        contextSignatures.set(cid, { text, at: now });
      }

      // 装了挂念，「朋友圈节奏」插件看到这个变量就让位
      const moments = getChatPluginVar('moments', 'character', cid) as Record<string, unknown> | null;
      if (!Number(h.settings?.momentsOn)) {
        if (moments) unsetChatPluginVar('moments', 'character', cid);
      } else {
        const next = { by: 'gua-nian', weeklyTarget: Number(h.settings?.momentsWeekly) || 0, minGapHours: Number(h.settings?.momentsGapH) || 0,
          lastPostAt: Number(h.settings?.momentsLast) || 0, weekN: Number(h.settings?.momentsWeekN) || 0 };
        const same = moments && Object.entries(next).every(([k, v]) => moments[k] === v);
        if (!same) setChatPluginVar('moments', { ...next, at: now }, 'character', cid);
      }
    } finally { publishing = false; }
    managed.set(cid, t.appId);
  }

  function writeCalendar(t: Target, h: HostCharacter) {
    const day = h.day;
    if (!day?.date || !Array.isArray(day.schedule)) return;
    const cid = t.characterId, date = day.date;
    const sched = day.schedule.filter(it => it && /^\d{2}:\d{2}$/.test(String(it.time || '')) && String(it.title || '').trim());
    const sig = JSON.stringify([date, sched.map(it => [it.time, it.end || '', it.title])]);
    if (calendarSignatures[cid] === sig) return;
    const owner = { ownerType: 'character', ownerId: cid, date };
    const plan = (readCustomAppCalendar(owner).plan || {}) as { items?: { id?: string; date?: string; startTime?: string }[] };
    const items = (plan.items || []).filter(it => it.date === date);
    for (const it of items) {
      if (/^guanian_/.test(String(it.id || ''))) { try { writeCustomAppCalendar({ ...owner, operation: 'delete', itemId: it.id }); } catch { /* 已经没了 */ } }
    }
    const keep = items.filter(it => !/^guanian_/.test(String(it.id || '')));
    sched.forEach((it, i) => {
      const time = String(it.time);
      if (keep.some(k => k.startTime === time)) return; // 日程表里已有的安排不重复写
      const next = sched[i + 1];
      const end = it.end && it.end > time ? it.end : next && String(next.time) > time ? String(next.time) : addMin(time, 60);
      try {
        writeCustomAppCalendar({ ...owner, id: `guanian_${date.replace(/-/g, '')}_${i}`, startTime: time, endTime: end > time ? end : '23:59', title: it.title, location: '', source: 'generated' });
      } catch { /* 单条写不进不挡其余 */ }
    });
    calendarSignatures[cid] = sig;
    kvSet(CALENDAR_KEY, JSON.stringify(calendarSignatures));
  }

  async function uploadInputs(t: Target) {
    const cid = t.characterId, now = Date.now();
    const aff = getChatPluginVar('affection', 'character', cid) as Record<string, unknown> | null;
    const affection = aff && typeof aff === 'object' && (aff.tier || aff.relation)
      ? { score: Number(aff.score) || 0, tier: String(aff.tier || ''), relation: String(aff.relation || '') } : null;
    const routineItems = (name: string) => {
      const v = getChatPluginVar(name, 'character', cid) as { items?: unknown } | null;
      return v && Array.isArray(v.items) ? v.items.filter(x => x && typeof x === 'object') : [];
    };
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const days = [presenceDate(now), presenceDate(tomorrow.getTime())].map(date => {
      const plan = (readCustomAppCalendar({ ownerType: 'character', ownerId: cid, date }).plan || {}) as { items?: Record<string, unknown>[] };
      const calendar = (plan.items || []).filter(it => it.date === date)
        .map(it => ({ id: it.id, date: it.date, startTime: it.startTime, endTime: it.endTime, title: it.title, location: it.location }));
      return { date, calendar, routine: routineItems('routine'), exceptions: routineItems('routineExceptions') };
    });
    const body = { affection, days, routineOn: t.settings.routineOn !== false };
    const sig = JSON.stringify(body);
    const prior = inputSignatures.get(cid);
    // 例外按 until 过期，内容不变也每 30 分钟寄一次让后端重算
    if (prior && prior.sig === sig && now - prior.at < 30 * 60_000) return;
    await api(t, characterPath(t, '/inputs'), { method: 'PUT', body: sig });
    inputSignatures.set(cid, { sig, at: now });
  }

  async function ackMoment(t: Target, id: string, status: string, note: string, postId = '') {
    await api(t, characterPath(t, '/moments/ack'), { method: 'POST', body: JSON.stringify({ id, status, note, postId }) });
  }
  // 一次只发最新的一条；积压的合并成未发布记录，不集中补发
  async function postMoments(t: Target, h: HostCharacter) {
    const list = (h.moments || []).filter(o => o && o.id && o.hint).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    if (!list.length) return;
    for (const o of list.slice(1)) await ackMoment(t, o.id, 'skipped', '积压起意已合并，仅保留最新一条');
    const o = list[0], key = `${t.characterId}:${o.id}`;
    if (posting.has(key)) return;
    posting.add(key);
    try {
      let postId: string | null = null;
      try {
        postId = (await postCustomAppMoment({ characterId: t.characterId, hint: o.hint, createdAt: Date.now(), requestId: `server:${o.id}` }, t.appId)).postId;
      } catch (e) {
        await ackMoment(t, o.id, 'failed', String(e instanceof Error ? e.message : e).slice(0, 200));
        return;
      }
      await ackMoment(t, o.id, postId ? 'sent' : 'skipped', postId ? '已取得帖子编号' : '宿主未创建帖子，可能内容重复或生成未完成', postId || '');
    } finally { posting.delete(key); }
  }

  async function refresh(force = false) {
    if (disposed || document.visibilityState === 'hidden') return;
    if (running) { again = again || force; return; }
    const list = targets();
    release(list);
    if (!list.length) return;
    const now = Date.now();
    if (!force && now - lastNet < NET_MS) {
      for (const t of list) { const got = latest.get(t.characterId); if (got) publish(t, got.h, got.at, now - got.at > 3 * NET_MS); }
      return;
    }
    running = true; lastNet = now;
    try {
      const groups = new Map<string, Target[]>();
      for (const t of list) { const { url, key } = guanianServerConfig(t.settings); groups.set(`${url}\n${key}`, [...(groups.get(`${url}\n${key}`) || []), t]); }
      for (const group of groups.values()) {
        let hosts: HostCharacter[] = [];
        try {
          const data = await api(group[0], `/app/host?ids=${encodeURIComponent(group.map(t => t.characterId).join(','))}`);
          hosts = Array.isArray(data.characters) ? data.characters as HostCharacter[] : [];
        } catch {
          // 后端一时连不上：用上次取到的接着算在线状态
          for (const t of group) { const got = latest.get(t.characterId); if (got) publish(t, got.h, got.at, true); }
          continue;
        }
        if (disposed) return;
        for (const t of group) {
          const h = hosts.find(x => x.characterId === t.characterId);
          if (!h || !h.exists || !h.enabled || h.error) continue;
          latest.set(t.characterId, { at: Date.now(), h, t });
          publish(t, h, Date.now(), false);
          try { writeCalendar(t, h); } catch { /* 下一分钟再写 */ }
          try { await uploadInputs(t); } catch { /* 下一分钟再寄 */ }
          try { await postMoments(t, h); } catch { /* 回执没寄到，下一分钟按 requestId 认回同一条 */ }
        }
      }
    } finally {
      running = false;
      if (again) { again = false; void refresh(true); }
    }
  }

  const onChange = () => { void refresh(true); };
  const onData = (event: Event) => { const d = (event as CustomEvent).detail; if (d?.collection === 'settings') onChange(); };
  const onVars = (event: Event) => {
    const name = (event as CustomEvent).detail?.name;
    if (publishing) return;
    if (name === 'presence') { void refresh(); return; }
    // 作息、例外、好感改了：几秒后寄一次
    if (name === 'routine' || name === 'routineExceptions' || name === 'affection') {
      window.clearTimeout(varTimer);
      varTimer = window.setTimeout(() => { lastNet = 0; void refresh(); }, 3000);
    }
  };
  const onVisibility = () => { if (document.visibilityState !== 'hidden') onChange(); };
  window.addEventListener(CUSTOM_APP_DATA_UPDATED_EVENT, onData);
  window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, onChange);
  window.addEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT, onVars);
  const onRefresh = () => { void refresh(); };
  window.addEventListener('guanian-presence-refresh', onRefresh);
  window.addEventListener('online', onChange);
  document.addEventListener('visibilitychange', onVisibility);
  // 在线状态按钟点算，15 秒重算一次；联网每分钟一次
  const clock = window.setInterval(() => { void refresh(); }, 15_000);
  void refresh(true);
  const stop = () => {
    disposed = true;
    window.clearInterval(clock); window.clearTimeout(varTimer);
    window.removeEventListener(CUSTOM_APP_DATA_UPDATED_EVENT, onData);
    window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, onChange);
    window.removeEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT, onVars);
    window.removeEventListener('guanian-presence-refresh', onRefresh);
    window.removeEventListener('online', onChange);
    document.removeEventListener('visibilitychange', onVisibility);
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;
  return stop;
}
