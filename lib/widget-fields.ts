import type { DIYFieldType, DIYTemplateField, DIYWidgetTemplate, WidgetInstance } from "./widget-types";

export const DIY_FIELD_TYPES: DIYFieldType[] = ["text", "number", "date", "time", "color", "select"];

export const DIY_FIELD_TYPE_LABELS: Record<DIYFieldType, string> = {
  text: "文字",
  number: "数字",
  date: "日期",
  time: "时间",
  color: "颜色",
  select: "下拉选择",
};

export const MAX_DIY_FIELDS = 20;

// key 直接进 config 又被代码按属性名取，限死成标识符，省得撞上原型链上的名字。
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidFieldKey(key: string): boolean {
  return FIELD_KEY_RE.test(key) && !RESERVED_KEYS.has(key) && key.length <= 40;
}

export function normalizeDIYFields(raw: unknown): DIYTemplateField[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DIYTemplateField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
    if (!isValidFieldKey(key) || seen.has(key)) continue;
    const type = DIY_FIELD_TYPES.includes(candidate.type as DIYFieldType) ? (candidate.type as DIYFieldType) : "text";
    const field: DIYTemplateField = {
      key,
      label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim().slice(0, 40) : key,
      type,
    };
    if (typeof candidate.placeholder === "string" && candidate.placeholder) field.placeholder = candidate.placeholder.slice(0, 60);
    if (type === "number" && typeof candidate.defaultValue === "number" && Number.isFinite(candidate.defaultValue)) {
      field.defaultValue = candidate.defaultValue;
    } else if (typeof candidate.defaultValue === "string" && candidate.defaultValue) {
      field.defaultValue = candidate.defaultValue.slice(0, 200);
    }
    if (type === "select") {
      const options = Array.isArray(candidate.options)
        ? candidate.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map(o => o.trim().slice(0, 40)).slice(0, 30)
        : [];
      if (!options.length) continue;
      field.options = options;
    }
    if (type === "text" && candidate.multiline === true) field.multiline = true;
    seen.add(key);
    out.push(field);
    if (out.length >= MAX_DIY_FIELDS) break;
  }
  return out;
}

export function diyFieldDefaults(fields: DIYTemplateField[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields || []) {
    if (field.defaultValue !== undefined && field.defaultValue !== "") out[field.key] = field.defaultValue;
    else if (field.type === "select" && field.options?.length) out[field.key] = field.options[0];
  }
  return out;
}

/** 组件读到的配置 = 字段默认值垫底 + 实例里用户填的值。用户填过空字符串也算填过，压得住默认值。 */
export function resolveWidgetConfig(template: Pick<DIYWidgetTemplate, "fields">, widget: Pick<WidgetInstance, "config">): Record<string, unknown> {
  const defaults = diyFieldDefaults(template.fields);
  if (!Object.keys(defaults).length) return widget.config || {};
  return { ...defaults, ...(widget.config || {}) };
}

/** 模板删掉字段后，把桌面上这个模板的实例里对应的值一起清掉，免得留着看不见也删不掉的残值。 */
export function dropRemovedFieldValues(
  widgets: WidgetInstance[],
  templateId: string,
  removedKeys: string[],
): WidgetInstance[] {
  if (!removedKeys.length) return widgets;
  let changed = false;
  const next = widgets.map((widget) => {
    if (widget.type !== templateId || !widget.config) return widget;
    const config = { ...widget.config };
    let hit = false;
    for (const key of removedKeys) {
      if (key in config) { delete config[key]; hit = true; }
    }
    if (!hit) return widget;
    changed = true;
    return { ...widget, config };
  });
  return changed ? next : widgets;
}

export function removedFieldKeys(prev: DIYTemplateField[] | undefined, next: DIYTemplateField[] | undefined): string[] {
  const kept = new Set((next || []).map(f => f.key));
  return (prev || []).map(f => f.key).filter(key => !kept.has(key));
}
