import { simpleLLMCall } from "./api-helpers";
import type { ApiConfig } from "./settings-types";
import { validateStatusFields, type AdventureStatusField } from "./adventure-status";

export type StatusSuggestionContext = {
  worldDescription: string;
  recentStory?: string[];
  playerName?: string;
  gameTime?: string;
};

/** Parse new suggestions only. Model-supplied IDs and edits to existing fields are ignored. */
export function mergeStatusSuggestions(content: string, existing: AdventureStatusField[], makeId: () => string): AdventureStatusField[] {
  validateStatusFields(existing);
  let parsed: { fields?: unknown };
  try {
    parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
  } catch { throw new Error("AI 返回格式不完整，请重新生成；原有字段未改变"); }
  if (!parsed || !Array.isArray(parsed.fields) || parsed.fields.length > 20) throw new Error("AI 返回的字段列表无效，请重新生成");
  const names = new Set(existing.map(f => f.name.trim()));
  const additions: AdventureStatusField[] = [];
  for (const raw of parsed.fields) {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string") throw new Error("AI 返回的字段缺少名称");
    const name = raw.name.trim();
    if (names.has(name)) continue;
    if (raw.type !== "text" && raw.type !== "number") throw new Error(`${name}：AI 返回了不支持的字段类型`);
    if (typeof raw.rule !== "string") throw new Error(`${name}：AI 未提供变更规则`);
    additions.push({ id: makeId(), name, type: raw.type, value: raw.value, rule: raw.rule,
      ...(raw.type === "number" ? { min: raw.min, max: raw.max } : {}),
    });
    names.add(name);
  }
  if (!additions.length) throw new Error("AI 没有建议新的字段，原有字段已保留");
  if (additions.length > 6) throw new Error("AI 一次建议的字段超过 6 个，请重新生成");
  const merged = [...existing.map(f => ({ ...f })), ...additions];
  validateStatusFields(merged);
  return merged;
}

export async function generateStatusSuggestions(
  config: ApiConfig,
  context: StatusSuggestionContext,
  existing: AdventureStatusField[],
  signal: AbortSignal,
): Promise<AdventureStatusField[]> {
  if (signal.aborted) throw new Error("已取消生成");
  if (!context.worldDescription.trim()) throw new Error("请先填写世界描述，再让 AI 生成字段");
  if (!config?.apiKey) throw new Error("请先配置冒险使用的模型 API");
  validateStatusFields(existing);
  if (existing.length >= 20) throw new Error("已达到 20 个字段上限");
  const result = await simpleLLMCall(config, [
    { role: "system", content: `你为角色扮演冒险设计玩家的自定义状态字段。根据当前世界题材、玩家身份与已有剧情，建议 1～${Math.min(6, 20 - existing.length)} 个最有用的新字段，不固定使用宫廷模板。
字段有两类：text 保存身份/职务/阵营/境界等文字状态；number 保存影响剧情的辅助数值，并提供合理的 min/max。不要重复游戏内已有的 HP、力量、体质、敏捷、智力、感知、魅力、运气、物品栏、任务和同伴好感度。
已有字段必须原样保留：只输出缺少的新字段，不改名、改类型、改值或换个近义名称重复创建。名称最长40字，文字值最长200字，变更规则最长800字。
每个字段必须给出当前值和变更规则。以已发生剧情为准，不把许诺/传闻/计划当成事实，不预演晋升、不泄露未知剧情。身份不明时填“待确认”；数值无证据时给出保守的建议初值，并在规则中注明初值待玩家确认。
身份改变必须由已发生并正式生效的剧情事件驱动；辅助数值只影响剧情，禁止数值达标自动改变身份。规则说明何时可以增减或变更，何时只能记为待发生事项。
输出严格 JSON，不要代码或解释：{"fields":[{"name":"字段名称","type":"text","value":"当前值","rule":"变更规则"},{"name":"辅助数值名称","type":"number","value":0,"min":0,"max":100,"rule":"增减依据与初值说明"}]}。这只是供用户预览的建议，不能声称已经保存或生效。` },
    { role: "user", content: JSON.stringify({
      world: context.worldDescription.slice(0, 12000),
      player: context.playerName || "玩家", gameTime: context.gameTime || "创建世界前",
      recentStory: (context.recentStory || []).slice(-12).map(text => text.slice(0, 1200)),
      existingFields: existing,
    }) },
  ], { temperature: 0.5, max_tokens: 4096, signal, label: "冒险·建议状态字段" });
  if (signal.aborted) throw new Error("已取消生成");
  if (!result.content) throw new Error(result.error || "AI 没有返回建议，请重试");
  if (result.wasTruncated) throw new Error("AI 返回被截断，未采用不完整字段，请重新生成");
  return mergeStatusSuggestions(result.content, existing, () => crypto.randomUUID());
}
