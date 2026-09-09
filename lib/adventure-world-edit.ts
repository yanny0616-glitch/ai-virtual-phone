import type { MapWorld, WorldNPC } from "./map-types";

export type WorldSettingOverrides = {
  revision: number;
  loreEdited: boolean;
  npcIds: string[];
  aliases: Record<string, string[]>;
};
export type WorldSettingChange = {
  target: string;
  field: "lore" | "name" | "personality";
  label: string;
  before: string;
  after: string;
  reason: string;
};
export type WorldSettingPlan = {
  worldId: string;
  baseVersion: string;
  changes: WorldSettingChange[];
};

export function worldSettingVersion(world: MapWorld): string {
  return JSON.stringify([world.id, world.skeleton, world.settingOverrides]);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("修改格式无效，请重新生成");
  return value as Record<string, unknown>;
}

function fieldValue(world: MapWorld, target: string, field: WorldSettingChange["field"]): { label: string; value: string } {
  if (target === "world" && field === "lore") return { label: "世界背景", value: world.skeleton.world.lore };
  const npc = world.skeleton.npcs.find(n => n.id === target);
  if (!npc || (field !== "name" && field !== "personality")) throw new Error("只能修改世界背景或已有 NPC 的姓名、人设");
  return { label: `${npc.name} · ${field === "name" ? "姓名" : "人设"}`, value: npc[field] };
}

/** A preview is built from actual current values, never model-provided before values. */
export function planWorldSettingEdit(world: MapWorld, output: unknown): WorldSettingPlan {
  const root = object(output);
  if (Object.keys(root).some(key => key !== "changes") || !Array.isArray(root.changes) || root.changes.length > 50) throw new Error("修改列表无效，只能提交 changes");
  const seen = new Set<string>();
  const changes: WorldSettingChange[] = [];
  for (const item of root.changes) {
    const p = object(item);
    if (Object.keys(p).some(key => !["target", "field", "value", "reason"].includes(key))) throw new Error("修改中包含不支持的操作");
    if (typeof p.target !== "string" || !["lore", "name", "personality"].includes(String(p.field))) throw new Error("修改目标无效");
    const field = p.field as WorldSettingChange["field"];
    const current = fieldValue(world, p.target, field);
    const key = `${p.target}:${field}`;
    if (seen.has(key)) throw new Error("同一字段重复修改，请重新生成");
    seen.add(key);
    const max = field === "lore" ? 20000 : field === "personality" ? 6000 : 60;
    if (typeof p.value !== "string" || !p.value.trim() || p.value.length > max) throw new Error(`${current.label}：内容为空或超过 ${max} 字`);
    if (typeof p.reason !== "string" || !p.reason.trim() || p.reason.length > 800) throw new Error(`${current.label}：缺少有效修改原因`);
    const after = p.value.trim();
    if (after !== current.value) changes.push({ target: p.target, field, label: current.label, before: current.value, after, reason: p.reason.trim() });
  }
  if (!changes.length) throw new Error("AI 没有提出有效改动，原设定已保留");
  const plan = { worldId: world.id, baseVersion: worldSettingVersion(world), changes };
  // Check NPC identity/node associations before presenting a saveable proposal.
  applyWorldSettingEdit(world, plan, world.updatedAt);
  return plan;
}

function npcNodeCopies(world: MapWorld, npc: WorldNPC) {
  const copies: { name: string; personality: string; role: string }[] = [];
  for (const region of world.skeleton.richRegions) {
    if (region.id !== npc.locationRegion) continue;
    if (region.l1_npc?.name === npc.name && (!npc.locationNode || npc.locationNode === region.l1_name_cn)) copies.push(region.l1_npc);
    for (const node of [...region.l2_nodes, ...region.l3_nodes]) {
      if (node.npc?.name === npc.name && (!npc.locationNode || node.name === npc.locationNode)) copies.push(node.npc);
    }
  }
  return copies;
}

/** Immutable application; preserves map layout, quest data, secrets and all game saves. */
export function applyWorldSettingEdit(world: MapWorld, plan: WorldSettingPlan, now: string): MapWorld {
  if (world.id !== plan.worldId || worldSettingVersion(world) !== plan.baseVersion) throw new Error("世界设定已变化，请重新生成预览，避免覆盖新内容");
  const next = structuredClone(world);
  const overrides: WorldSettingOverrides = structuredClone(world.settingOverrides ?? { revision: 0, loreEdited: false, npcIds: [], aliases: {} });
  const touched = new Set<string>();
  for (const change of plan.changes) {
    const current = fieldValue(world, change.target, change.field);
    if (current.value !== change.before) throw new Error("预览原值已变化，请重新生成");
    if (change.target === "world") {
      next.skeleton.world.lore = change.after;
      overrides.loreEdited = true;
      continue;
    }
    const original = world.skeleton.npcs.find(n => n.id === change.target)!;
    const npc = next.skeleton.npcs.find(n => n.id === change.target)!;
    // Find copies using the original identity, even when the same plan renames it.
    const baselineCopies = npcNodeCopies(world, original);
    if (baselineCopies.length !== 1) throw new Error(`${original.name}：无法唯一对应地图中的 NPC，未保存改动`);
    // Locate the same object in the cloned graph before either field is modified.
    const pathNpc = next.skeleton.richRegions.flatMap((r, ri) => {
      const baseline = world.skeleton.richRegions[ri];
      return [
        ...(baseline.l1_npc === baselineCopies[0] && r.l1_npc ? [r.l1_npc] : []),
        ...r.l2_nodes.flatMap((n, ni) => baseline.l2_nodes[ni].npc === baselineCopies[0] && n.npc ? [n.npc] : []),
        ...r.l3_nodes.flatMap((n, ni) => baseline.l3_nodes[ni].npc === baselineCopies[0] && n.npc ? [n.npc] : []),
      ];
    })[0];
    if (change.field === "name") {
      if (world.skeleton.npcs.some(n => n.id !== npc.id && (n.name === change.after || world.settingOverrides?.aliases[n.id]?.includes(change.after))) || touched.has(`name:${change.after}`)) throw new Error("NPC 新姓名与其他人物或其旧名重复，请换一个名字");
      touched.add(`name:${change.after}`);
      overrides.aliases[npc.id] = [...new Set([...(overrides.aliases[npc.id] || []), original.name])].filter(name => name !== change.after);
      npc.name = pathNpc.name = change.after;
    } else if (change.field === "personality") {
      npc.personality = pathNpc.personality = change.after;
    }
    touched.add(npc.id);
  }
  overrides.npcIds = [...new Set([...overrides.npcIds, ...plan.changes.filter(c => c.target !== "world").map(c => c.target)])];
  overrides.revision++;
  next.settingOverrides = overrides;
  next.updatedAt = now;
  return next;
}

/** Public, bounded-by-the-edited-fields context; never includes the DM secret dossier. */
export function worldSettingContext(world?: MapWorld | null, includeValues = true): string {
  if (!world?.settingOverrides) return "";
  const overrides = world.settingOverrides;
  return `\n【最新世界设定 · 第${overrides.revision}版】\n${JSON.stringify({
    ...(overrides.loreEdited && includeValues ? { background: world.skeleton.world.lore } : {}),
    npcs: world.skeleton.npcs.filter(n => overrides.npcIds.includes(n.id)).map(n => ({ name: n.name, ...(includeValues ? { personality: n.personality } : {}), previousNames: overrides.aliases[n.id] || [] })),
  })}\n以上是用户保存的设定修订，不是剧情中发生的新事件。若旧对话、任务文字或旧摘要与此冲突，以本版设定为准；旧名指同一人物，不要另造 NPC，不因此重置进度或发生晋升。\n`;
}

export function findCurrentWorldNpc(world: MapWorld, name?: string): WorldNPC | undefined {
  if (!name) return undefined;
  const matches = world.skeleton.npcs.filter(n => n.name === name || world.settingOverrides?.aliases[n.id]?.includes(name));
  return matches.length === 1 ? matches[0] : undefined;
}
