import { createBuiltinPreset, PATCHABLE_PROMPT_IDS } from "./builtin-preset";
import { getPromptTags } from "./content-tag-utils";
import type { PresetConfig, Prompt } from "./settings-types";

function alreadyProvidesFeature(existing: Prompt, required: Prompt): boolean {
    // 同名标识的自定义内容和关闭状态都保留。
    if (existing.identifier === required.identifier) return true;
    if (existing.marker) return false;
    const macro = required.content.trim().match(/^\{\{\s*(\w+)\s*\}\}$/)?.[1];
    if (!macro || !Array.from(existing.content.matchAll(/\{\{\s*(\w+)\s*\}\}/g)).some(match => match[1] === macro)) return false;
    const tags = getPromptTags(existing);
    // 手动接入的条目即使改名、限制为文字聊天或关闭，也不另加一条绕过它。
    return tags.length === 0 || getPromptTags(required).every(tag => tags.includes(tag));
}

/** 用户点击补齐时调用；清单仅包含宿主声明的必要入口，不复制整份内置预设。 */
export function completePresetFeatures(preset: PresetConfig): { preset: PresetConfig; added: Prompt[] } {
    const factory = createBuiltinPreset();
    const added = factory.prompts.filter(required =>
        PATCHABLE_PROMPT_IDS.includes(required.identifier)
        && !preset.prompts.some(existing => alreadyProvidesFeature(existing, required)),
    );
    if (!added.length) return { preset, added };

    const order = [...(preset.prompt_order ?? [])];
    const orderedIds = new Set(order.map(entry => entry.identifier));
    // 原来不在 order 里的条目会在组装时排到末尾，先补它们的顺序，避免被新入口插队。
    for (const prompt of [...preset.prompts, ...added]) {
        if (orderedIds.has(prompt.identifier)) continue;
        order.push({ identifier: prompt.identifier, enabled: prompt.enabled });
        orderedIds.add(prompt.identifier);
    }
    return { preset: { ...preset, prompts: [...preset.prompts, ...added], prompt_order: order }, added };
}
