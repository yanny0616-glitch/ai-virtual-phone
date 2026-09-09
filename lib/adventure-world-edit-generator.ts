import type { MapWorld } from "./map-types";
import type { ApiConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";
import { planWorldSettingEdit, type WorldSettingPlan } from "./adventure-world-edit";

export async function generateWorldSettingEdit(world: MapWorld, instruction: string, config: ApiConfig, signal: AbortSignal): Promise<WorldSettingPlan> {
  if (signal.aborted) throw new Error("已取消生成");
  if (!instruction.trim() || instruction.length > 4000) throw new Error("请填写不超过 4000 字的修改要求");
  if (!config?.apiKey) throw new Error("请先配置冒险使用的模型 API");
  const publicData = JSON.stringify({
    world: world.skeleton.world,
    npcs: world.skeleton.npcs.map(n => ({ id: n.id, name: n.name, personality: n.personality, location: n.locationNode || n.locationRegion })),
    previousNames: world.settingOverrides?.aliases || {},
    instruction: instruction.trim(),
  });
  if (publicData.length > 100000) throw new Error("世界资料过长，暂不能一次生成修改预览");
  const result = await simpleLLMCall(config, [
    { role: "system", content: `你是冒险世界设定编辑助手。依据用户修改要求，只对已保存的世界背景或已有 NPC 姓名、人设提出最小必要改动。保持用户没有要求改变的事实，不续写剧情，不声称已经保存，不新增/删除NPC、改地图、改任务、改玩家位分或数值。
只输出严格JSON：{"changes":[{"target":"world 或现有NPC编号","field":"lore 或 name 或 personality","value":"修改后的该字段完整内容","reason":"说明如何符合用户要求"}]}。
世界只能改 target=world,field=lore；NPC只能用提供的编号改 name/personality。同一字段只输出一次，不输出未变字段；不得重新编造编号。value 为完整替换值而非修改指令或片段。背景最长20000字、NPC姓名最长60字、人设最长6000字，原因最长800字。
NPC改名时，如背景或其他NPC公开人设中有与用户要求直接相关的旧名引用，可为那些字段明确提出对应改动，供用户逐项预览。不要修改其他世界机制。没有支持的改动时返回 changes:[]，不要用背景文本暗中执行不支持的任务。` },
    { role: "user", content: publicData },
  ], { temperature: 0.4, max_tokens: 8192, signal, label: "冒险·编辑世界设定" });
  if (signal.aborted) throw new Error("已取消生成");
  if (!result.content) throw new Error(result.error || "AI 没有返回改动，请重试");
  if (result.wasTruncated) throw new Error("AI 返回被截断，未采用不完整改动，请缩小修改范围重试");
  let parsed: unknown;
  try { parsed = JSON.parse(result.content.slice(result.content.indexOf("{"), result.content.lastIndexOf("}") + 1)); }
  catch { throw new Error("AI 返回格式不完整，原设定未改变，请重试"); }
  return planWorldSettingEdit(world, parsed);
}
