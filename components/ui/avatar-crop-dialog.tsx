"use client";

import { useEffect, useRef, useState } from "react";
import { ContentDialog } from "./modal";

type Props = {
  /** 待裁图片（object URL 或 data URL） */
  src: string;
  /** 输出边长（像素），正方形 */
  outputSize?: number;
  title?: string;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
};

const VIEW = 260;
const MAX_ZOOM = 5;

type Pointer = { x: number; y: number };

/** 圆形取景框内单指拖动、双指缩放（桌面滚轮缩放），确认后按框内区域出 webp。 */
export function AvatarCropDialog({ src, outputSize = 320, title = "裁剪头像", onConfirm, onCancel }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  // 图片左上角相对取景框左上角的偏移 + 当前绝对缩放（渲染像素 / 原图像素）
  const [view, setView] = useState({ ox: 0, oy: 0, scale: 1 });
  const viewRef = useRef(view);
  const apply = (next: typeof view) => { viewRef.current = next; setView(next); };
  const pointers = useRef(new Map<number, Pointer>());
  const gesture = useRef<{ dist: number; scale: number; mid: Pointer } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = new Image();
    el.onload = () => {
      const scale = VIEW / Math.min(el.naturalWidth, el.naturalHeight);
      const initial = { ox: (VIEW - el.naturalWidth * scale) / 2, oy: (VIEW - el.naturalHeight * scale) / 2, scale };
      viewRef.current = initial;
      setView(initial);
      setImg(el);
    };
    el.src = src;
  }, [src]);

  const minScale = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;

  const clamp = (ox: number, oy: number, scale: number) => {
    if (!img) return { ox, oy, scale };
    const s = Math.min(Math.max(scale, minScale), minScale * MAX_ZOOM);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    return { ox: Math.min(0, Math.max(VIEW - w, ox)), oy: Math.min(0, Math.max(VIEW - h, oy)), scale: s };
  };

  /** 以取景框内某点为锚缩放，锚点下的图像内容保持不动 */
  const zoomAt = (anchor: Pointer, nextScale: number, from = viewRef.current) => {
    const ratio = nextScale / from.scale;
    return clamp(anchor.x - (anchor.x - from.ox) * ratio, anchor.y - (anchor.y - from.oy) * ratio, nextScale);
  };

  const localPoint = (e: React.PointerEvent | React.WheelEvent): Pointer => {
    const rect = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: viewRef.current.scale, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !img) return;
    const cur = localPoint(e);
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size >= 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scaled = zoomAt(gesture.current.mid, gesture.current.scale * (dist / gesture.current.dist));
      const next = clamp(scaled.ox + (mid.x - gesture.current.mid.x), scaled.oy + (mid.y - gesture.current.mid.y), scaled.scale);
      gesture.current = { dist, scale: next.scale, mid };
      apply(next);
      return;
    }
    const v = viewRef.current;
    apply(clamp(v.ox + (cur.x - prev.x), v.oy + (cur.y - prev.y), v.scale));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!img) return;
    apply(zoomAt(localPoint(e), viewRef.current.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  };

  const confirm = () => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext("2d")!;
    const { ox, oy, scale } = viewRef.current;
    ctx.drawImage(img, -ox / scale, -oy / scale, VIEW / scale, VIEW / scale, 0, 0, outputSize, outputSize);
    onConfirm(canvas.toDataURL("image/webp", 0.85));
  };

  return (
    <ContentDialog title={title} confirmLabel="确定" onConfirm={confirm} onCancel={onCancel} confirmDisabled={!img}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <div
          ref={boxRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{ width: VIEW, height: VIEW, maxWidth: "100%", position: "relative", overflow: "hidden", borderRadius: 8, background: "#000", touchAction: "none", cursor: "grab", userSelect: "none" }}
        >
          {img && (
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: 0, top: 0, width: img.naturalWidth * view.scale, height: img.naturalHeight * view.scale, maxWidth: "none", transform: `translate(${view.ox}px, ${view.oy}px)`, pointerEvents: "none" }}
            />
          )}
          <div style={{ position: "absolute", inset: 0, borderRadius: "50%", boxShadow: "0 0 0 999px rgba(0,0,0,0.55)", pointerEvents: "none" }} />
        </div>
        <span className="ts-11" style={{ opacity: 0.6 }}>拖动移动 · 双指或滚轮缩放</span>
      </div>
    </ContentDialog>
  );
}
