"use client";
import { useState } from "react";
import type { DIYTemplateField } from "@/lib/widget-types";
import { ContentDialog } from "@/components/ui/modal";

type WidgetFieldFormProps = {
  title: string;
  fields: DIYTemplateField[];
  values: Record<string, unknown>;
  onSave: (values: Record<string, unknown>) => void;
  onClose: () => void;
};

const INPUT_TYPE: Record<DIYTemplateField["type"], string> = {
  text: "text",
  number: "number",
  date: "date",
  time: "time",
  color: "color",
  select: "text",
};

function initialValue(field: DIYTemplateField, saved: unknown): string {
  if (saved !== undefined && saved !== null) return String(saved);
  if (field.defaultValue !== undefined) return String(field.defaultValue);
  if (field.type === "select") return field.options?.[0] ?? "";
  if (field.type === "color") return "#888888";
  return "";
}

export function WidgetFieldForm({ title, fields, values, onSave, onClose }: WidgetFieldFormProps) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const field of fields) out[field.key] = initialValue(field, values[field.key]);
    return out;
  });

  function commit() {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = draft[field.key] ?? "";
      if (field.type === "number") {
        const num = Number(raw);
        // 空着就不写这个键，组件读到的是作者给的默认值，而不是 NaN。
        if (raw.trim() && Number.isFinite(num)) next[field.key] = num;
      } else {
        next[field.key] = raw;
      }
    }
    onSave(next);
  }

  return (
    <ContentDialog title={title} confirmLabel="保存" cancelLabel="取消" onConfirm={commit} onCancel={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {fields.map((field) => (
          <label key={field.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="ts-13" style={{ color: "var(--c-text-sub)", fontWeight: 600 }}>{field.label}</span>
            {field.type === "select" ? (
              <select
                className="ui-select"
                value={draft[field.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              >
                {(field.options || []).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            ) : field.type === "text" && field.multiline ? (
              <textarea
                className="ui-input"
                rows={3}
                placeholder={field.placeholder}
                value={draft[field.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                style={{ resize: "vertical" }}
              />
            ) : (
              <input
                className="ui-input"
                type={INPUT_TYPE[field.type]}
                placeholder={field.placeholder}
                value={draft[field.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                style={field.type === "color" ? { height: 38, padding: 4 } : undefined}
              />
            )}
          </label>
        ))}
        {!fields.length && <p className="ts-13" style={{ color: "var(--c-text-sub)" }}>这个组件没有可填字段。</p>}
      </div>
    </ContentDialog>
  );
}
