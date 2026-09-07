/** Pure, absolute-time rules. Embedded in push-generate by push:build-dist. */
export type CloudReplyTiming = {
    disabled?: boolean;
    expiresAt?: number;
    nextAt: number;
    reason?: "busy" | "sleep";
    windowKey?: string;
    availableUntil?: number;
    check?: boolean;
    note: string;
    peekMin: number;
    adaptive: boolean;
    probability: number;
    windows: { from: number; to: number; title: string; key: string; focused: boolean; breaks: { from: number; to: number }[] }[];
    sleeps: { from: number; to: number }[];
    sleepBufferMin: number;
    sleepWakeProbability: number;
};

export function advanceCloudReplyTiming(input: CloudReplyTiming, now: number, random: () => number = Math.random): CloudReplyTiming & { ready: boolean } {
    const t = { ...input };
    if (t.disabled || (t.expiresAt != null && now >= t.expiresAt)) return { ...t, ready: true, check: false, note: "现在可以回复对方，把等待期间的消息合起来自然回复。" };
    if (t.nextAt > now) return { ...t, ready: false };
    const wait = (minutes: number) => minutes * (0.6 + random() * 0.8) * 60_000;
    const sleep = t.sleeps.find(w => w.from <= now && now < w.to);
    if (sleep && t.reason !== "sleep" && t.sleepWakeProbability > 0 && random() * 100 < t.sleepWakeProbability) {
        return { ...t, ready: true, check: false, note: "你正睡着，被消息吵醒了，迷迷糊糊，只回一两句短的，之后还要接着睡。" };
    }
    if (sleep) return { ...t, ready: false, reason: "sleep", check: false, windowKey: undefined,
        nextAt: sleep.to + wait(t.sleepBufferMin), note: "你刚起床，才看到等待期间对方发来的消息。把消息合起来自然回复。" };
    const win = t.peekMin > 0 ? t.windows.find(w => w.from <= now && now < w.to) : undefined;
    if (!win) return { ...t, ready: true, check: false, note: t.reason === "sleep" ? t.note : "你现在才有空看手机。把等待期间对方的消息合起来回复，不要说还在先前的活动里偷空。" };
    const pause = win.breaks.find(w => w.from <= now && now < w.to);
    const futurePause = win.breaks.find(w => w.from > now);
    const nextCheck = () => Math.min(now + wait(t.peekMin), futurePause?.from ?? win.to);
    const same = t.reason === "busy" && t.windowKey === win.key && (!t.availableUntil || now < t.availableUntil);
    if (!same) {
        t.reason = "busy"; t.windowKey = win.key; t.availableUntil = undefined; t.check = false;
        if (t.adaptive && win.focused) {
            if (pause || (t.probability <= 0 && futurePause)) {
                const rest = pause ?? futurePause!;
                const start = Math.max(now, rest.from);
                t.nextAt = start + Math.min(wait(t.peekMin), (rest.to - start) / 2);
                t.availableUntil = rest.to;
            } else if (t.probability > 0) { t.nextAt = nextCheck(); t.check = true; }
            else t.nextAt = win.to + Math.min(wait(t.peekMin), 300_000);
        } else t.nextAt = Math.min(now + wait(t.peekMin), win.to + 60_000);
        return { ...t, ready: false };
    }
    if (t.check && !pause && random() * 100 >= t.probability) return { ...t, ready: false, nextAt: nextCheck() };
    return { ...t, ready: true, check: false, note: pause
        ? `你正在${win.title}的休息间隙。把等待期间对方的消息合起来简短回复，之后还要继续忙。`
        : `你还在${win.title || "忙事情"}，刚抽出一点空看手机。把等待期间对方的消息合起来简短回复，之后还要继续忙；不要声称活动结束，也不要虚构正式休息。` };
}
