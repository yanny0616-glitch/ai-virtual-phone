"use client";

// 角色可见范围：全局默认 + 各功能单独覆盖。改的是「列表里显不显示」，不动角色数据。

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import {
  CHARACTER_VISIBILITY_HOST_FEATURES,
  collectCharacterTags,
  customAppVisibilityId,
  loadCharacterVisibility,
  saveCharacterVisibility,
  type CharacterVisibilityConfig,
  type CharacterVisibilityRule,
} from "@/lib/character-visibility";

type Feature = { id: string; label: string; custom?: boolean };

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value];
}

function RuleEditor({
  rule, tags, characters, onChange,
}: {
  rule: CharacterVisibilityRule;
  tags: string[];
  characters: Character[];
  onChange: (next: CharacterVisibilityRule) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="menu-desc !mt-0">按标签隐藏（角色带任一勾选标签就不显示）</span>
        {tags.length === 0 ? (
          <span className="menu-desc !mt-0 opacity-60">还没有角色打过标签。到角色资料里给角色加标签后，这里就能选。</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map(tag => (
              <button
                key={tag}
                type="button"
                className="ui-chip"
                data-selected={rule.hiddenTags.includes(tag) ? "true" : undefined}
                onClick={() => onChange({ ...rule, hiddenTags: toggle(rule.hiddenTags, tag) })}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="menu-desc !mt-0">点名隐藏角色</span>
        <div className="flex flex-wrap gap-1.5">
          {characters.map(character => (
            <button
              key={character.id}
              type="button"
              className="ui-chip"
              data-selected={rule.hiddenIds.includes(character.id) ? "true" : undefined}
              onClick={() => onChange({ ...rule, hiddenIds: toggle(rule.hiddenIds, character.id) })}
            >
              {character.avatar ? <img src={character.avatar} alt="" className="ui-chip-avatar" /> : null}
              {character.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CharacterVisibilitySettings() {
  const [config, setConfig] = useState<CharacterVisibilityConfig>(() => loadCharacterVisibility());
  const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
  const [customApps, setCustomApps] = useState(() => loadInstalledCustomApps());
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      setCharacters(loadCharacters());
      setCustomApps(loadInstalledCustomApps());
    };
    window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refresh);
  }, []);

  const tags = useMemo(() => collectCharacterTags(characters), [characters]);
  const features = useMemo<Feature[]>(() => [
    ...CHARACTER_VISIBILITY_HOST_FEATURES,
    ...customApps.map(app => ({ id: customAppVisibilityId(app.manifest.id), label: app.name, custom: true })),
  ], [customApps]);

  const commit = (next: CharacterVisibilityConfig) => {
    setConfig(next);
    saveCharacterVisibility(next);
  };

  const describe = (rule: CharacterVisibilityRule) => {
    const parts: string[] = [];
    if (rule.hiddenTags.length) parts.push(`隐藏标签：${rule.hiddenTags.join("、")}`);
    if (rule.hiddenIds.length) parts.push(`隐藏 ${rule.hiddenIds.length} 个角色`);
    return parts.length ? parts.join(" · ") : "全部显示";
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="menu-desc !mt-0">
        决定各功能的角色列表里显示谁。只影响列表显示，不影响聊天、联系人和角色数据。
        没单独设置的功能都跟着全局默认走；自定义 APP 拿到的角色列表也会按这里过滤。
      </p>

      <section className="g-card flex flex-col gap-3 px-3.5 py-3">
        <div className="flex flex-col">
          <span className="menu-label">全局默认</span>
          <span className="menu-desc !mt-0">{describe(config.default)}</span>
        </div>
        <RuleEditor
          rule={config.default}
          tags={tags}
          characters={characters}
          onChange={rule => commit({ ...config, default: rule })}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="settings-menu-section-title">按功能单独设置</h3>
        {features.map(feature => {
          const own = config.apps[feature.id];
          const isOpen = expanded === feature.id;
          return (
            <div key={feature.id} className="g-card flex flex-col gap-3 px-3.5 py-3">
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                onClick={() => setExpanded(isOpen ? null : feature.id)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="menu-label">{feature.label}{feature.custom ? <span className="ml-1.5 text-[10px] opacity-50">APP</span> : null}</span>
                  <span className="menu-desc !mt-0">{own ? `单独设置 · ${describe(own)}` : "跟随全局默认"}</span>
                </span>
                {isOpen ? <ChevronDown size={16} className="opacity-50" /> : <ChevronRight size={16} className="opacity-50" />}
              </button>
              {isOpen && (
                <>
                  <RuleEditor
                    rule={own ?? config.default}
                    tags={tags}
                    characters={characters}
                    onChange={rule => commit({ ...config, apps: { ...config.apps, [feature.id]: rule } })}
                  />
                  {own && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline self-start"
                      onClick={() => {
                        const apps = { ...config.apps };
                        delete apps[feature.id];
                        commit({ ...config, apps });
                      }}
                    >
                      <RotateCcw size={14} /> 恢复跟随全局默认
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
