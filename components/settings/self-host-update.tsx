"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DownloadCloud, Loader2, RefreshCw } from "lucide-react";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type UpdateInfo = {
    ok: boolean;
    current: string;
    latest: { sha: string; tag: string; publishedAt: string } | null;
    building: boolean;
    updateAvailable: boolean;
    error?: string;
};

const updateIconStyle = {
    "--icon-color": BINDING_ACCENTS.api,
} as CSSProperties;

export function SelfHostUpdateCard({ onNotice }: { onNotice: (msg: string) => void }) {
    const [info, setInfo] = useState<UpdateInfo | null>(null);
    const [checking, setChecking] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [updated, setUpdated] = useState(false);
    const pollRef = useRef<number | null>(null);

    const check = useCallback(async (): Promise<UpdateInfo | null> => {
        try {
            const res = await fetch("/api/self-host/update", { cache: "no-store" });
            const data = await res.json() as UpdateInfo;
            setInfo(data);
            return data;
        } catch {
            // 部署重启窗口内请求会失败，轮询方负责重试
            return null;
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => { void check(); }, 0);
        return () => {
            window.clearTimeout(timer);
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
        };
    }, [check]);

    const handleCheck = async () => {
        if (checking || updating) return;
        setChecking(true);
        try {
            const data = await check();
            if (!data) onNotice("检查失败：网络异常");
            else if (!data.ok) onNotice(data.error || "检查失败");
            else if (!data.updateAvailable) onNotice("已是最新版本");
        } finally {
            setChecking(false);
        }
    };

    const handleUpdate = async () => {
        if (updating || !info?.latest) return;
        const target = info.latest.sha;
        setUpdating(true);
        try {
            const res = await fetch("/api/self-host/update", { method: "POST" });
            const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
            if (!data?.ok) {
                onNotice(data?.error || "触发更新失败");
                setUpdating(false);
                return;
            }
        } catch {
            onNotice("触发更新失败");
            setUpdating(false);
            return;
        }
        const startedAt = Date.now();
        pollRef.current = window.setInterval(() => {
            void check().then(data => {
                if (data?.ok && data.current === target) {
                    if (pollRef.current !== null) window.clearInterval(pollRef.current);
                    pollRef.current = null;
                    setUpdating(false);
                    setUpdated(true);
                } else if (Date.now() - startedAt > 5 * 60_000) {
                    if (pollRef.current !== null) window.clearInterval(pollRef.current);
                    pollRef.current = null;
                    setUpdating(false);
                    onNotice("更新还没完成：稍后再点「检查更新」确认");
                }
            });
        }, 5000);
    };

    // 接口不可用（非 float-deploy 部署）时整卡隐藏；首个响应回来前也先不占位
    if (!info?.ok) return null;

    const desc = updated
        ? `已更新到 ${info.current}，刷新页面生效`
        : updating
            ? "更新中…下载、切换、重启服务，约 1 分钟"
            : info.updateAvailable && info.latest
                ? `当前 ${info.current || "未知"} → 最新构建 ${info.latest.sha}`
                : `当前 ${info.current || "未知"}${info.building ? " · GitHub 有新提交在构建" : " · 已是最新"}`;

    return (
        <div className="app-card card-featured settings-toggle-card">
            <span className="card-icon" style={updateIconStyle}>
                <DownloadCloud size={22} strokeWidth={1.75} />
            </span>
            <div className="card-featured-body">
                <div className="card-featured-label">版本更新</div>
                <div className="card-featured-desc">{desc}</div>
            </div>
            {updated ? (
                <button className="ui-btn ui-btn-primary py-1 px-3 ts-12" style={{ whiteSpace: "nowrap" }} onClick={() => window.location.reload()}>刷新页面</button>
            ) : info.updateAvailable ? (
                <button className="ui-btn ui-btn-primary py-1 px-3 ts-12" style={{ whiteSpace: "nowrap" }} disabled={updating} onClick={() => void handleUpdate()}>
                    {updating ? <Loader2 size={14} className="animate-spin" /> : "立即更新"}
                </button>
            ) : (
                <button className="ui-btn ui-btn-outline py-1 px-3 ts-12" style={{ whiteSpace: "nowrap" }} disabled={checking || updating} onClick={() => void handleCheck()}>
                    {checking ? <Loader2 size={14} className="animate-spin" /> : <span className="inline-flex items-center gap-1"><RefreshCw size={13} />检查更新</span>}
                </button>
            )}
        </div>
    );
}
