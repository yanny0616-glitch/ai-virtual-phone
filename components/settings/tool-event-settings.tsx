"use client";
import { useEffect, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { loadToolEventKey, saveToolEventKey, enableToolEventReceive, toolEventRequest, type ToolEventStatus } from "@/lib/tool-event-client";
import type { McpServerConfig } from "@/lib/settings-types";
import { Input, Select } from "@/components/ui/form";

type Adapter = "garden" | "webhook";
type Mode = "auto" | "receive";

const STATUS_LABEL: Record<string, { text: string; variant: "success" | "warning" | "muted" }> = {
  connected: { text: "已启用", variant: "success" },
  connecting: { text: "正在连接", variant: "warning" },
  stopped: { text: "已停止", variant: "muted" },
};

export function ToolEventSettings({ server }: { server: McpServerConfig }) {
  const isGarden = server.url.replace(/\/$/, "") === "https://galatea.abysslumina.com/mcp";
  const [state, setState] = useState<ToolEventStatus>();
  const [characterId, setCharacter] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [adapter, setAdapter] = useState<Adapter>(isGarden ? "garden" : "webhook");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pairKey, setPairKey] = useState(() => loadToolEventKey());
  const [characters] = useState(() => loadCharacters());

  useEffect(() => {
    let alive = true;
    void toolEventRequest({ action: "status", serverId: server.id }).then(s => {
      if (!alive) return;
      setState(s);
      setCharacter(s.config?.characterId || "");
      setMode(s.config?.mode || "auto");
      setAdapter(s.config?.adapter || (isGarden ? "garden" : "webhook"));
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [server.id, isGarden]);

  async function act(action: string) {
    saveToolEventKey(pairKey);
    setBusy(true);
    setError("");
    try {
      const gardenToken = token || server.accessToken || Object.entries(server.headers || {}).find(([k]) => k.toLowerCase() === "authorization")?.[1] || "";
      const s = await toolEventRequest({
        action,
        serverId: server.id,
        ...(action === "save" ? { characterId, mode, adapter, serverUrl: server.url, token: adapter === "garden" ? gardenToken : undefined } : {}),
      });
      setState(s);
      setToken("");
      if (action === "save" || action === "start") enableToolEventReceive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyAdapter() {
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        url: `${window.location.origin}/api/tool-events/ingest`,
        headers: { Authorization: `Bearer ${state?.ingressToken}` },
        body: { version: 1, sourceId: server.id, eventId: "每条事件的唯一ID；重试使用原ID", reason: "notification", message: "交给角色的事件文本" },
      }, null, 2));
    } catch {
      setError("复制失败，请从下方手动复制。");
    }
  }

  const changed = !state?.config || state.config.characterId !== characterId || state.config.mode !== mode || state.config.adapter !== adapter || state.config.serverUrl !== server.url || Boolean(token);
  const status = state ? (STATUS_LABEL[state.status] || { text: state.status, variant: "muted" as const }) : { text: "读取中", variant: "muted" as const };
  const pending = state?.pending || 0;

  return (
    <details className="tool-event-fold">
      <summary>
        <span className="tool-event-fold-title">事件唤醒</span>
        <span className="tool-event-fold-meta">
          <span className="ui-status-tag" data-variant={status.variant}>{status.text}</span>
          {pending > 0 && <span className="ui-status-tag" data-variant="warning">待处理 {pending}</span>}
        </span>
      </summary>
      <div className="tool-event-body">
        <p className="menu-desc">让这个 MCP 来源主动把事件推给角色。每个来源独立配置，默认关闭；VPS 暂存事件，Float 打开后交给角色，手机关闭时不会执行模型或工具。改完配置要先保存再启动。</p>

        <div className="tool-event-field">
          <label className="menu-desc">本机连接码</label>
          <Input type="password" autoComplete="off" value={pairKey} onChange={e => setPairKey(e.target.value)} placeholder="沿用原花园唤醒连接码" />
        </div>
        <div className="tool-event-field">
          <label className="menu-desc">事件接入方式</label>
          <Select value={adapter} onChange={e => setAdapter(e.target.value as Adapter)}>
            <option value="webhook">通用 Webhook（外部适配器投递）</option>
            {isGarden && <option value="garden">花园唤醒桥</option>}
          </Select>
        </div>
        <div className="tool-event-field">
          <label className="menu-desc">目标角色</label>
          <Select value={characterId} onChange={e => setCharacter(e.target.value)}>
            <option value="">请选择角色</option>
            {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="tool-event-field">
          <label className="menu-desc">处理方式</label>
          <Select value={mode} onChange={e => setMode(e.target.value as Mode)}>
            <option value="auto">自动交给角色处理（Float 运行时）</option>
            <option value="receive">仅接收至聊天，不自动调用</option>
          </Select>
        </div>
        {adapter === "garden" && (
          <div className="tool-event-field">
            <label className="menu-desc">花园 Machine Token</label>
            <Input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={state?.config?.hasToken ? "已保存；留空保留或复用当前 MCP Token" : "留空使用当前 MCP Token"} />
          </div>
        )}
        <p className="menu-desc tool-event-hint">{adapter === "garden" ? "花园断线后会停止，需要手动恢复。" : "Webhook 需要服务或适配器主动投递；只提供工具的 MCP 不会自己产生事件。"}</p>
        {(error || state?.lastError) && <p role="alert" className="menu-desc tool-event-error">{error || state?.lastError}</p>}

        <div className="tool-event-actions">
          <button type="button" className="ui-btn ui-btn-primary tool-event-btn" disabled={busy || !characterId} onClick={() => void act("save")}>保存配置</button>
          <button type="button" className="ui-btn ui-btn-soft-action tool-event-btn" disabled={busy || changed} onClick={() => void act("start")}>启动</button>
          <button type="button" className="ui-btn ui-btn-outline tool-event-btn" disabled={busy} onClick={() => void act("stop")}>停止</button>
          <button type="button" className="ui-btn ui-btn-outline tool-event-btn" disabled={busy} onClick={() => void act("status")}>刷新</button>
          {adapter === "webhook" && <button type="button" className="ui-btn ui-btn-outline tool-event-btn" disabled={busy} onClick={() => void act("credentials")}>投递配置</button>}
          <button type="button" className="ui-btn ui-btn-soft-danger tool-event-btn" disabled={busy} onClick={() => { if (window.confirm("仅删除这个来源的唤醒配置和待处理事件？")) void act("clear"); }}>清除</button>
        </div>

        {state?.ingressToken && (
          <div className="tool-event-ingress">
            <p className="menu-desc">下面三项只交给这个来源的适配器，不要发给模型。它不能选择角色，也管不了其他来源。</p>
            <div className="tool-event-field"><label className="menu-desc">投递端点</label><Input readOnly value={`${window.location.origin}/api/tool-events/ingest`} /></div>
            <div className="tool-event-field"><label className="menu-desc">来源 ID</label><Input readOnly value={server.id} /></div>
            <div className="tool-event-field"><label className="menu-desc">投递密钥</label><Input type="password" readOnly value={state.ingressToken} /></div>
            <button type="button" className="ui-btn ui-btn-soft-action tool-event-btn self-start" onClick={() => void copyAdapter()}>复制适配器配置</button>
          </div>
        )}
      </div>
    </details>
  );
}
