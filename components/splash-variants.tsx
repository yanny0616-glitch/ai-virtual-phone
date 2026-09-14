"use client";

import { SplashAnimation } from "./splash-animation";
import type { SplashVariantId } from "@/lib/splash-config";

// 几套纯 CSS 开屏（keyframes 在 styles/base.css）。默认的「漂浮」仍是 canvas 版 SplashAnimation。
// 都是 absolute 铺满父级 .splash-phone-screen；外观页预览时放进等比小盒子里同样成立。

function InkSplash() {
  return (
    <div className="splash-variant splash-ink" aria-hidden>
      <div className="splash-ink-glow" />
      <div className="splash-ink-title">
        {"float".split("").map((ch, i) => (
          <span key={i} style={{ animationDelay: `${300 + i * 140}ms` }}>{ch}</span>
        ))}
      </div>
      <div className="splash-ink-line" />
      <div className="splash-ink-tagline">weightless · ai</div>
    </div>
  );
}

function AuroraSplash() {
  return (
    <div className="splash-variant splash-aurora" aria-hidden>
      <div className="splash-aurora-blob splash-aurora-blob-a" />
      <div className="splash-aurora-blob splash-aurora-blob-b" />
      <div className="splash-aurora-blob splash-aurora-blob-c" />
      <div className="splash-aurora-veil" />
      <div className="splash-aurora-title">float</div>
      <div className="splash-aurora-tagline">a phone that remembers</div>
    </div>
  );
}

function PulseSplash() {
  return (
    <div className="splash-variant splash-pulse" aria-hidden>
      <div className="splash-pulse-dots" />
      <div className="splash-pulse-rings">
        <span style={{ animationDelay: "0s" }} />
        <span style={{ animationDelay: "1.2s" }} />
        <span style={{ animationDelay: "2.4s" }} />
      </div>
      <div className="splash-pulse-core" />
      <div className="splash-pulse-text">
        <span className="splash-pulse-typed">float / 0.1</span>
        <span className="splash-pulse-caret" />
      </div>
      <div className="splash-pulse-corner">sys.ready</div>
    </div>
  );
}

export function SplashVariant({ variant }: { variant: SplashVariantId }) {
  if (variant === "ink") return <InkSplash />;
  if (variant === "aurora") return <AuroraSplash />;
  if (variant === "pulse") return <PulseSplash />;
  // "none" 也渲染默认动画：主壳会在水合完成后自动跳过，之前那一两秒总得有画面
  return <SplashAnimation />;
}
