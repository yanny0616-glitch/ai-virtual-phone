import { getPromptTags } from "./content-tag-utils";
import type { PresetConfig, Prompt } from "./settings-types";

export const PRESET_SYNC_FIELDS = {
    name: "名称", content: "内容", role: "消息角色", tags: "适用范围",
    injection_depth: "注入深度", injection_position: "注入位置",
    marker: "占位条目", system_prompt: "系统提示标记", forbid_overrides: "禁止覆盖",
} as const;
export type PresetSyncField = keyof typeof PRESET_SYNC_FIELDS;
export type PresetEntryDiff = {
    identifier: string;
    kind: "missing" | "changed";
    source: Prompt;
    current?: Prompt;
    fields: PresetSyncField[];
    /** Only reviewed fields; independent toggle/order changes do not invalidate review. */
    reviewKey: string;
};

function values(prompt: Prompt) {
    return {
        name: prompt.name, content: prompt.content, role: prompt.role,
        tags: [...new Set(getPromptTags(prompt))].sort(),
        injection_depth: prompt.injection_depth ?? 0, injection_position: prompt.injection_position ?? 0,
        marker: prompt.marker === true, system_prompt: prompt.system_prompt === true,
        forbid_overrides: prompt.forbid_overrides === true,
    };
}

function orderedPrompts(preset: PresetConfig): Prompt[] {
    const prompts = [...preset.prompts];
    const rank = new Map((preset.prompt_order ?? []).map((entry, index) => [entry.identifier, index]));
    return prompts.sort((a, b) => (rank.get(a.identifier) ?? Infinity) - (rank.get(b.identifier) ?? Infinity));
}

/** Compare against the installed built-in copy, including entries installed by custom apps. */
export function diffPresetEntries(target: PresetConfig, source: PresetConfig): { entries: PresetEntryDiff[]; warnings: string[] } {
    const entries: PresetEntryDiff[] = [], warnings: string[] = [];
    const seen = new Set<string>();
    for (const prompt of orderedPrompts(source)) {
        if (!prompt.identifier || seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        const matches = target.prompts.filter(p => p.identifier === prompt.identifier);
        if (matches.length > 1 || source.prompts.filter(p => p.identifier === prompt.identifier).length > 1) {
            warnings.push(`“${prompt.name}”存在重复条目，请先整理后再同步该条。`);
            continue;
        }
        const current = matches[0];
        if (!current && target.prompts.some(p => p.name === prompt.name)) {
            warnings.push(`“${prompt.name}”已有同名但标识不同的条目；选择新增会保留原条目。`);
        }
        const incoming = values(prompt), existing = current ? values(current) : undefined;
        const fields = (Object.keys(PRESET_SYNC_FIELDS) as PresetSyncField[])
            .filter(field => !existing || JSON.stringify(incoming[field]) !== JSON.stringify(existing[field]));
        if (!fields.length) continue;
        const enabled = (source.prompt_order ?? []).find(entry => entry.identifier === prompt.identifier)?.enabled ?? prompt.enabled;
        entries.push({ identifier: prompt.identifier, kind: current ? "changed" : "missing", source: structuredClone(prompt),
            current: current ? structuredClone(current) : undefined, fields,
            reviewKey: JSON.stringify([prompt.identifier, incoming, existing, current ? null : [prompt.enabled, enabled]]) });
    }
    return { entries, warnings };
}

export function syncPresetEntries(target: PresetConfig, source: PresetConfig, selected: string[]): {
    preset: PresetConfig; added: string[]; updated: string[];
} {
    const wanted = new Set(selected);
    const entries = diffPresetEntries(target, source).entries.filter(entry => wanted.has(entry.identifier));
    if (!entries.length) return { preset: target, added: [], updated: [] };
    const changes = new Map(entries.map(entry => [entry.identifier, entry]));
    const prompts = target.prompts.map(prompt => {
        const change = changes.get(prompt.identifier);
        if (!change || change.kind !== "changed") return prompt;
        // Keep both levels of enable state, user ordering, and unrelated extension metadata.
        const result = { ...prompt };
        for (const field of Object.keys(PRESET_SYNC_FIELDS) as PresetSyncField[]) {
            if (field === "tags") continue;
            if (change.source[field] === undefined) delete (result as Partial<Prompt>)[field];
            else Object.assign(result, { [field]: structuredClone(change.source[field]) });
        }
        result.tags = [...getPromptTags(change.source)];
        delete result.featureTag; delete result.followUpOnly;
        return result;
    });
    const missing = entries.filter(entry => entry.kind === "missing");
    prompts.push(...missing.map(entry => structuredClone(entry.source)));
    const order = (target.prompt_order ?? []).map(entry => ({ ...entry }));
    const ordered = new Set(order.map(entry => entry.identifier));
    // Preserve the target's effective order, including existing entries omitted from prompt_order.
    for (const prompt of target.prompts) if (!ordered.has(prompt.identifier)) {
        order.push({ identifier: prompt.identifier, enabled: prompt.enabled }); ordered.add(prompt.identifier);
    }
    const sourceOrder = orderedPrompts(source);
    for (const entry of missing) {
        const sourceEnabled = (source.prompt_order ?? []).find(p => p.identifier === entry.identifier)?.enabled ?? entry.source.enabled;
        // Reuse an orphan order row, but new prompts follow the source's enable state.
        if (ordered.has(entry.identifier)) {
            const orphan = order.find(item => item.identifier === entry.identifier);
            if (orphan) orphan.enabled = sourceEnabled;
            continue;
        }
        const next = sourceOrder.slice(sourceOrder.findIndex(p => p.identifier === entry.identifier) + 1)
            .find(p => ordered.has(p.identifier));
        const index = next ? order.findIndex(p => p.identifier === next.identifier) : order.length;
        order.splice(index, 0, { identifier: entry.identifier, enabled: sourceEnabled });
        ordered.add(entry.identifier);
    }
    return { preset: { ...target, prompts, prompt_order: order },
        added: missing.map(entry => entry.source.name),
        updated: entries.filter(entry => entry.kind === "changed").map(entry => entry.source.name) };
}
