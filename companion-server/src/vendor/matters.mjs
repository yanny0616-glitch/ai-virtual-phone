// BEGIN GUANIAN MATTERS
// Pure shared matter identity and reservation rules. Semantic matching belongs to
// the existing judgment call; identities/evidence/one active task are checked here.
export function matterItemId(w) {
  return w.wakeId ? 'wake:' + w.wakeId : 'slot:' + Number(w.origFireAt || w.fireAt || 0) + ':' + String(w.source || '');
}
export function matterKey(w, threads = []) {
  const thread = threads.find(t => t.id === w.from);
  return String(w.matterId || thread?.matterId || (w.from ? 'thread:' + w.from : matterItemId(w)));
}
export function matterOutputKey(o, items, threads) {
  const w = items.find(w => o.trigger_key === 'timedwake:' + w.wakeId);
  if (w) return matterKey(w, threads);
  const meta = o.meta?.guanianContext;
  return String(meta?.matterId || (meta?.eventId ? 'thread:' + meta.eventId : 'sent:' + o.id));
}
export function matterCatalog(items, threads, outputs) {
  return [
    ...threads.map(t => ({ matterId: String(t.matterId || 'thread:' + t.id), threadId: t.id, kind: t.kind,
      text: t.text, done: !!t.done, due: t.due || 0 })),
    ...items.map(w => ({ itemId: matterItemId(w), matterId: matterKey(w, threads), kind: w.kind || 'ordinary',
      intent: w.intent || w.source, act: !!w.act, fireAt: w.fireAt, generatedAt: w.generatedAt || 0 })),
    ...outputs.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 12).map(o => ({ matterId: matterOutputKey(o, items, threads), sentAt: o.created_at,
      messageId: 'push-outbox:' + o.id, text: String(o.raw_text || '').slice(0, 4000) })),
  ];
}
export function matterPrompt(items, threads, outputs) {
  return '【事项去重，必须先于 decisions/extra/keep 判断】\n' + JSON.stringify(matterCatalog(items, threads, outputs))
    + '\n上述包含普通念头、明确约定及实际已生成的正文。按同一个具体沟通目的匹配，不按宽泛话题或相似词猜测；承诺稍后回答不等于已经回答，尚未履行的约定不能因为提过话题就作罢；换时间、标题或说法不是新事项。'
    + '额外输出 links:[{itemId:"已有念头编号",matterId:"它实际属于的已有事项编号",relation:"same或followup",sourceMessageId:"新进展的真实聊天编号，无则空"}]，把已有重复念头归到同一 matterId；优先使用明确约定的 matterId。'
    + 'extra 与 keep 每条都增加 matterId：已有事情必须复用上述编号；只有真正新事才用 new:1 或 new:2，同轮同一新事必须用同一编号。'
    + '同一事项已有待发任务就不再 extra；要改时间用原任务 decisions.defer，约定改期用 keep.id/when。'
    + '已问过但用户没回答不是新进展，不可重复催问；已经说完、回答、拒绝或取消的事项作罢。'
    + '发过后确有新进展才可 relation=followup，并提供晚于上次发送的用户消息或线下摘要 sourceMessageId；仅新的角色主动消息、时间流逝不算。'
    + 'extra 还须带 relation:"new|same|followup"、sourceMessageId。明确约定进入 keep，不同时排 extra。'
    + '普通念头已经解决用 decisions.act=false 且 defer 为空，约定完成/取消用 keep 的原 id 和 status，必须引用真实证据。';
}
export function prepareMatters(items, threads, outputs, judgment, nowMs) {
  const catalog = matterCatalog(items, threads, outputs);
  const known = new Set(catalog.map(r => r.matterId));
  const resolve = value => {
    const id = String(value || '');
    return known.has(id) ? id : /^new:[12]$/.test(id) ? 'matter:' + nowMs + ':' + id.slice(4) : '';
  };
  const next = items.map(w => ({ ...w, matterId: matterKey(w, threads) }));
  const links = Array.isArray(judgment.links) ? judgment.links.slice(0, 40) : [];
  // Resolve against the original catalog, then collapse aliases transitively.
  // Conflicting assignments and cycles are ignored instead of guessing ownership.
  const aliases = new Map();
  for (const link of links) {
    if (!link || !known.has(String(link.matterId || ''))) continue;
    const w = next.find(w => matterItemId(w) === link.itemId);
    if (!w || w.matterId === link.matterId) continue;
    if (aliases.has(w.matterId) && aliases.get(w.matterId) !== link.matterId) aliases.set(w.matterId, '');
    else aliases.set(w.matterId, link.matterId);
  }
  const canonical = id => {
    const seen = new Set(); let curr = id;
    while (aliases.has(curr)) {
      if (seen.has(curr) || !aliases.get(curr)) return id;
      seen.add(curr); curr = aliases.get(curr);
    }
    return curr;
  };
  for (const w of next) {
    w.matterId = canonical(w.matterId);
    const link = links.find(l => l && l.itemId === matterItemId(w) && canonical(String(l.matterId || '')) === w.matterId);
    if (link) {
      w.matterRelation = link.relation === 'followup' ? 'followup' : 'same';
      w.matterEvidenceId = String(link.sourceMessageId || '').slice(0, 150);
    }
  }
  const enrich = k => {
    if (!k || typeof k !== 'object') return null;
    const original = threads.find(t => t.id === String(k.id || k.from || '').replace(/[\[\]\s]/g, ''));
    const id = original ? String(original.matterId || 'thread:' + original.id) : resolve(k.matterId);
    const owner = threads.find(t => String(t.matterId || 'thread:' + t.id) === canonical(id) && t.kind === k.kind);
    return { ...k, ...(owner ? { id: owner.id } : {}), matterId: canonical(id), matterRelation: k.relation === 'followup' ? 'followup' : 'same',
      matterEvidenceId: String(k.sourceMessageId || '').slice(0, 150) };
  };
  return { items: next,
    threads: threads.map(t => {
      const id = canonical(String(t.matterId || 'thread:' + t.id));
      return { ...t, matterId: id };
    }),
    keep: (Array.isArray(judgment.keep) ? judgment.keep : []).map(enrich).filter(Boolean),
    extra: (Array.isArray(judgment.extra) ? judgment.extra : []).map(enrich).filter(k => k?.matterId),
  };
}
export function matterBlock(w, items, threads, outputs, messages) {
  if (w.matterSuppressed) return '已被事项去重撤销的任务';
  const key = matterKey(w, threads);
  const sameThreads = threads.filter(t => String(t.matterId || 'thread:' + t.id) === key);
  if (sameThreads.some(t => t.done || ['completed', 'cancelled'].includes(t.status))) return '同一事项已经了结';
  // Only genuine generation evidence counts, never a passed scheduled time.
  const sentAt = Math.max(0, ...items.filter(i => matterKey(i, threads) === key).map(i => Number(i.generatedAt) || 0),
    ...outputs.filter(o => matterOutputKey(o, items, threads) === key).map(o => Date.parse(o.created_at) || 0));
  if (sentAt) {
    const evidence = messages.find(m => String(m.id || '') === String(w.matterEvidenceId || '') && m.id);
    const fresh = evidence && (evidence.role === 'user' || evidence.media_type === 'offline_summary')
      && Number(evidence.t ?? Date.parse(evidence.message_at || '')) > sentAt;
    if (w.matterRelation !== 'followup' || !fresh) return '同一事项已发过，未核实新的聊天进展';
  }
  if (w.kind !== 'promise' && sameThreads.some(t => t.kind === 'promise' && !t.done)) return '同一事项由明确约定负责';
  const pending = items.filter(i => i.act && !i.generatedAt && matterKey(i, threads) === key
    && !outputs.some(o => o.trigger_key === 'timedwake:' + i.wakeId));
  if (!pending.includes(w)) {
    if (pending.length) return '同一事项已有待发送任务';
    pending.push(w);
  }
  pending.sort((a, b) => Number(b.kind === 'promise') - Number(a.kind === 'promise')
    || Number(a.fireAt || 0) - Number(b.fireAt || 0) || matterItemId(a).localeCompare(matterItemId(b)));
  if (pending[0] !== w) return '同一事项已有待发送任务';
  return '';
}
export function matterFields(value) {
  return { matterId: String(value.matterId || ''), matterRelation: String(value.matterRelation || ''),
    matterEvidenceId: String(value.matterEvidenceId || '') };
}
// END GUANIAN MATTERS
