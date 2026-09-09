/** Optional, per-save narrative state. Pure functions; no browser/storage/clock access. */
export type AdventureStatusField = {
  id: string;
  name: string;
  type: "text" | "number";
  value: string | number;
  rule: string;
  min?: number;
  max?: number;
};

export type AdventureStatusRecord = {
  id: string;
  fieldId: string;
  fieldName: string;
  from: string | number;
  to: string | number;
  reason: string;
  evidence: string;
  status: "applied" | "pending" | "resolved" | "dismissed";
  source: "dm" | "manual";
  gameTime: string;
  createdAt: string;
};

export type AdventureStatus = {
  enabled: boolean;
  revision: number;
  fields: AdventureStatusField[];
  records: AdventureStatusRecord[];
};

export const emptyAdventureStatus = (): AdventureStatus => ({ enabled: false, revision: 0, fields: [], records: [] });

export function palaceStatusFields(): AdventureStatusField[] {
  return [
    { id: "palace_rank", name: "位分", type: "text", value: "待设定", rule: "仅正式生效的册封、晋封或降位改变位分；提议、传闻、许诺只记录为待发生。宠爱和威望不直接决定位分。" },
    { id: "palace_residence", name: "居所", type: "text", value: "待设定", rule: "正式分配或实际迁居后变更。" },
    { id: "palace_favor", name: "宠爱", type: "number", value: 0, min: 0, max: 100, rule: "根据已经发生的皇帝互动小幅增减，必须说明依据；不自动换算位分。" },
    { id: "palace_prestige", name: "威望", type: "number", value: 0, min: 0, max: 100, rule: "根据已发生事件对声望的影响增减，必须说明依据；不自动换算位分。" },
  ];
}

export function validateStatusFields(fields: AdventureStatusField[]): void {
  if (fields.length > 20) throw new Error("最多设置 20 个状态字段");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const f of fields) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(f.id) || ids.has(f.id)) throw new Error("字段编号无效或重复");
    if (!f.name.trim() || f.name.length > 40 || names.has(f.name.trim())) throw new Error("字段名称不能为空、重复或超过 40 字");
    if (!f.rule.trim() || f.rule.length > 800) throw new Error(`${f.name}：请填写不超过 800 字的变更规则`);
    ids.add(f.id); names.add(f.name.trim());
    if (f.type !== "text" && f.type !== "number") throw new Error("不支持的字段类型");
    if (f.type === "number" && (!Number.isFinite(f.min) || !Number.isFinite(f.max) || f.min! > f.max!)) throw new Error(`${f.name}：数值范围无效`);
    if (!validValue(f, f.value)) throw new Error(`${f.name}：值为空、类型不符或超出范围`);
  }
}

function describeField(f: AdventureStatusField): string {
  return `名称：${f.name}；${f.type === "number" ? `范围：${f.min}～${f.max}；` : ""}规则：${f.rule}`;
}

function validValue(f: AdventureStatusField, value: unknown): value is string | number {
  return f.type === "text"
    ? typeof value === "string" && value.trim().length > 0 && value.length <= 200
    : typeof value === "number" && Number.isFinite(value) && value >= f.min! && value <= f.max!;
}

type Stamp = { id: string; gameTime: string; createdAt: string };

/** Save explicit user edits, preserving history (including removed fields). */
export function editAdventureStatus(
  previous: AdventureStatus | undefined,
  enabled: boolean,
  fields: AdventureStatusField[],
  reason: string,
  stamp: Stamp,
): AdventureStatus {
  validateStatusFields(fields);
  if (enabled && !fields.length) throw new Error("请先添加至少一个状态字段");
  const old = previous ?? emptyAdventureStatus();
  const nextFields = fields.map(f => ({ ...f, name: f.name.trim(), rule: f.rule.trim() }));
  if (old.enabled === enabled && JSON.stringify(old.fields) === JSON.stringify(nextFields)) return old;
  if (!reason.trim() || reason.length > 800) throw new Error("请填写不超过 800 字的设置或纠正原因");
  let records = [...old.records];
  const changed = new Set<string>();
  const addRecord = (fieldId: string, fieldName: string, from: string | number, to: string | number) => {
    records.push({ ...stamp, id: `${stamp.id}_${records.length}`, fieldId, fieldName, from, to, reason: reason.trim(), evidence: "", status: "applied", source: "manual" });
  };
  if (old.enabled !== enabled) addRecord("_enabled", "自定义状态", old.enabled ? "开启" : "关闭", enabled ? "开启" : "关闭");
  for (const f of nextFields) {
    const before = old.fields.find(o => o.id === f.id);
    if (before && before.type !== f.type) throw new Error(`${f.name}：已有字段不能改变类型，请另建字段`);
    if (!before || before.value !== f.value) {
      changed.add(f.id);
      addRecord(f.id, f.name, before?.value ?? "未设置", f.value);
    } else if (JSON.stringify(before) !== JSON.stringify(f)) {
      addRecord(f.id, f.name, describeField(before), describeField(f));
    }
  }
  for (const f of old.fields.filter(f => !nextFields.some(n => n.id === f.id))) {
    changed.add(f.id);
    addRecord(f.id, f.name, f.value, "字段已移除");
  }
  // Manual correction supersedes unconfirmed proposals for that field.
  records = records.map(r => r.status === "pending" && changed.has(r.fieldId) ? { ...r, status: "dismissed" } : r);
  return { enabled, fields: nextFields, records, revision: old.revision + 1 };
}

export function dismissStatusProposal(state: AdventureStatus, recordId: string, reason: string, stamp: Stamp): AdventureStatus {
  const record = state.records.find(r => r.id === recordId && r.status === "pending");
  if (!record) throw new Error("该待发生事项已处理，请重新打开面板");
  if (!reason.trim() || reason.length > 800) throw new Error("请填写不超过 800 字的撤销原因");
  return { ...state, revision: state.revision + 1, records: [
    ...state.records.map(r => r.id === recordId ? { ...r, status: "dismissed" as const } : r),
    { ...stamp, fieldId: record.fieldId, fieldName: record.fieldName, from: record.to, to: "待发生事项已撤销", reason: reason.trim(), evidence: "", source: "manual", status: "applied" },
  ] };
}

/** Only the host owns field definitions. Model data is untrusted and cannot add fields. */
export function applyAdventureStatusChanges(
  previous: AdventureStatus | undefined,
  changes: unknown,
  context: Stamp & { expectedRevision?: number; narrative: string },
): { state: AdventureStatus | undefined; warnings: string[] } {
  if (!previous?.enabled || changes === undefined) return { state: previous, warnings: [] };
  if (!Array.isArray(changes) || changes.length > 40) return { state: previous, warnings: ["状态更新格式无效，已保留原值"] };
  if (changes.length === 0) return { state: previous, warnings: [] };
  if (context.expectedRevision !== previous.revision) return { state: previous, warnings: ["生成期间状态已改变，未覆盖新状态，请检查本轮剧情"] };
  let fields = previous.fields.map(f => ({ ...f }));
  let records = [...previous.records];
  const warnings: string[] = [];
  let changed = false;
  const processed = new Set<string>();
  for (const [index, raw] of changes.entries()) {
    const reject = (message: string) => warnings.push(`第 ${index + 1} 项状态更新未应用：${message}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { reject("格式无效"); continue; }
    const p = raw as Record<string, unknown>;
    const field = fields.find(f => f.id === p.fieldId);
    if (!field) { reject("字段不存在"); continue; }
    const recordId = `${context.id}_${index}`;
    if (records.some(r => r.id === recordId)) continue;
    if (processed.has(field.id)) { reject("同轮同字段只能更新一次"); continue; }
    if (p.kind !== "occurred" && p.kind !== "pending") { reject("必须区分已发生与待发生"); continue; }
    if (!validValue(field, p.to) || p.from !== field.value) { reject(`${field.name}的原值不符或新值超出范围`); continue; }
    if (typeof p.reason !== "string" || !p.reason.trim() || p.reason.length > 800 || typeof p.evidence !== "string" || p.evidence.trim().length < 4 || p.evidence.length > 1200 || !context.narrative.includes(p.evidence.trim())) {
      reject("缺少原因或本轮正文中的原文依据"); continue;
    }
    processed.add(field.id);
    if (p.to === field.value) continue;
    if (p.kind === "pending" && records.some(r => r.status === "pending" && r.fieldId === field.id && r.to === p.to)) continue;
    if (p.kind === "occurred") {
      fields = fields.map(f => f.id === field.id ? { ...f, value: p.to as string | number } : f);
      records = records.map(r => r.status === "pending" && r.fieldId === field.id
        ? { ...r, status: r.to === p.to ? "resolved" : "dismissed" } : r);
    }
    records.push({ id: recordId, fieldId: field.id, fieldName: field.name, from: field.value, to: p.to,
      reason: p.reason.trim(), evidence: p.evidence.trim(), status: p.kind === "occurred" ? "applied" : "pending",
      source: "dm", gameTime: context.gameTime, createdAt: context.createdAt });
    changed = true;
  }
  return { state: changed ? { ...previous, fields, records, revision: previous.revision + 1 } : previous, warnings };
}

/** History stays in the save; only current values and a bounded recent slice enter the prompt. */
export function adventureStatusContext(state?: AdventureStatus): string {
  if (!state?.enabled) return "";
  return `\n【玩家自定义状态·以此处最新存档为准，优先于旧剧情中的状态】\n${JSON.stringify({
    fields: state.fields,
    pending: state.records.filter(r => r.status === "pending").slice(-10).map(r => ({ fieldId: r.fieldId, to: r.to, reason: r.reason })),
    recent: state.records.filter(r => r.status === "applied").slice(-5).map(r => ({ field: r.fieldName, from: r.from, to: r.to, reason: r.reason })),
  })}\n辅助数值只影响剧情，不直接决定身份。角色的提议、愿望和许诺不等于已经生效的状态变更。\n`;
}

export function adventureStatusInstruction(state?: AdventureStatus): string {
  if (!state?.enabled) return "";
  return `\n【可选自定义状态协议】\n在原有回复 JSON 中额外输出 status_changes 数组，无变更为 []。只能更新已定义字段，遵守每个字段的 rule。格式：\n{"fieldId":"字段编号","from":"存档当前值","to":"新值","kind":"occurred 或 pending","reason":"变更原因","evidence":"本轮 narration 或 npc_lines.text 中连续、完整表达事件事实的原文"}\n数字字段的 from/to 必须是 JSON 数字，使用变更后的绝对值并遵守 min/max，不能输出增量。每轮每字段至多一项。\n只有本轮正文明确发生并已生效的事件才能标 occurred；身份变化必须有正式生效依据（如有权者的册封旨意），不得因宠爱、威望达标或玩家自称而自动晋位。提议、传闻、许诺、计划只标 pending，不能修改当前值。引用旧册封不算新事件。evidence 不得从选项、用户宣言或历史抄取，不得只截取引文省略否定/假设语境。没有依据就不提交。数值变化也必须有已发生的剧情依据。不输出未配置字段。\n`;
}
