// 唤醒后端（VPS）：工具箱里 MCP 的「事件唤醒」选了「交给 VPS 后端」的来源，由后端 24 小时领事件、调工具、回复。
// 小手机这边只做一件事：给每个这样的来源冻一份底稿寄过去——
//   聊天提示词 + 完整聊天记录 + 末尾一条占位的用户消息（后端换成事件原文）、
//   只含这个 MCP 的工具定义（原生协议）或它的指令说明（文字协议）、MCP 地址和请求头。
// 工具箱仍是原件：改了 MCP、预设、人设，下次同步就重寄。不再交给后端的来源，底稿从后端删掉。
// 鉴权用个人云 Secret key（与挂念直连同一把），后端拿它去个人云核对。
import { buildChatPromptMessages, buildNativeChatTools, nativeToolSourceKey } from './chat-engine';
import { addChatContact, createOrGetSession, getMaxToolRounds, loadChatContacts, loadChatMessages, type ChatMessage } from './chat-storage';
import { isCloudBackupConfigured, loadCloudBackupConfig } from './cloud-backup/config';
import { GUANIAN_SERVER_URL } from './guanian-server-sync';
import { kvGet, kvSet, registerKvMigration } from './kv-db';
import { buildProviderRequest, nativeToolProtocolForConfig, toLlmRequestMessages } from './llm-provider-adapter';
import { buildMcpAuthHeaders } from './tool-executor';
import { toolEventEnabled, toolEventRequest, type ToolEventStatus } from './tool-event-client';
import { formatToolSchema } from './tool-prompt';
import { getEnabledTools, loadMcpServers, type EnabledTool } from './tool-storage';

export const WAKE_EVENT_PLACEHOLDER = '__FLOAT_WAKE_EVENT__';
export const WAKE_SERVER_SYNC_EVENT = 'wake-server-sync';
const UPLOADED_KEY = 'wake_server_uploaded_v1';
registerKvMigration(UPLOADED_KEY);
/** 聊天没动也每隔这么久重寄一次：时间、记忆、MCP 令牌可能变了 */
const REFRESH_MS = 30 * 60_000;
const MIN_GAP_MS = 60_000;

type Source = NonNullable<ToolEventStatus['sources']>[number];
type Uploaded = Record<string, { characterId: string; sig: string; at: number }>;

export function wakeServerAuth(): { url: string; key: string } | null {
  const backup = loadCloudBackupConfig();
  return isCloudBackupConfigured(backup) ? { url: GUANIAN_SERVER_URL, key: backup.key.trim() } : null;
}

export async function wakeServerApi<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = wakeServerAuth();
  if (!auth) throw new Error('还没有配置个人云（云备份里的 Supabase 地址和 Secret key），连不上唤醒后端');
  const res = await fetch(auth.url + path, {
    ...init,
    headers: { Authorization: `Bearer ${auth.key}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `唤醒后端 HTTP ${res.status}`);
  return data;
}

/** 给一个来源冻底稿：和手机自己处理事件时同一条提示词管线，只是工具只留绑定的 MCP */
export async function buildWakeTemplate(source: { serverId: string; characterId: string }) {
  if (!loadChatContacts().some(c => c.characterId === source.characterId)) addChatContact(source.characterId);
  const session = createOrGetSession(source.characterId);
  const placeholder: ChatMessage = { id: 'wake_event_placeholder', sessionId: session.id, role: 'user', content: WAKE_EVENT_PLACEHOLDER, status: 'sent', createdAt: new Date().toISOString() };
  const toolFilter = (tool: EnabledTool) => tool.source === 'mcp_server' && tool.sourceId === source.serverId;
  const { llmMessages, character, config, preset, regexes, userIdentity, toolsEnabled } = await buildChatPromptMessages(
    session, [...loadChatMessages(session.id), placeholder], { appTags: ['chat', 'text'], toolFilter },
  );
  const tool = toolsEnabled ? getEnabledTools('chat').find(toolFilter) : undefined;
  const names = { characterName: character.name, userName: userIdentity?.name ?? '用户' };
  const native = Boolean(tool && nativeToolProtocolForConfig(config));
  let toolNames: Record<string, string> = {};
  let schemaText: Record<string, string> = {};
  let request;
  if (tool && native) {
    // 直接展开成具体动作，后端不用处理「展开说明」这一步
    const bundle = buildNativeChatTools([tool], [nativeToolSourceKey(tool)], names);
    toolNames = Object.fromEntries([...bundle.nameMap].filter(([name]) => !bundle.loaderMap.has(name)));
    const definitions = bundle.definitions.filter(d => !bundle.loaderMap.has(d.name));
    request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages), definitions.length ? { tools: definitions } : {});
  } else {
    if (tool) schemaText = { [tool.name]: formatToolSchema(tool, names) };
    request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
  }
  const server = loadMcpServers().find(s => s.id === source.serverId && s.enabled);
  return {
    sourceId: source.serverId,
    characterId: source.characterId,
    sessionId: session.id,
    capturedAt: Date.now(),
    request: { url: request.url, headers: request.headers, body: request.body, providerKind: request.providerKind },
    placeholder: WAKE_EVENT_PLACEHOLDER,
    protocol: tool ? (native ? (Object.keys(toolNames).length ? 'native' : 'none') : 'text') : 'none',
    toolNames,
    schemaText,
    mcp: server && /^https:\/\//.test(server.url) ? { url: server.url, headers: buildMcpAuthHeaders(server) } : null,
    maxRounds: getMaxToolRounds(),
    merge: {
      sessionId: session.id,
      onlineThinking: { enabled: preset?.online_thinking_enabled === true, tag: preset?.online_thinking_tag?.trim() || 'thinking' },
      regexes,
      characterName: character.name,
      userName: names.userName,
      appId: 'chat',
      appTags: ['chat', 'text'],
      tzOffsetMin: -new Date().getTimezoneOffset(),
    },
    notify: { title: character.name, url: '/' },
  };
}

function loadUploaded(): Uploaded {
  try { return JSON.parse(kvGet(UPLOADED_KEY) || '{}') || {}; } catch { return {}; }
}

/** 聊天、MCP、来源配置的签名：没变就不重建（重建要跑记忆召回） */
function signature(source: Source): string {
  const session = createOrGetSession(source.characterId);
  const last = loadChatMessages(session.id).at(-1);
  const server = loadMcpServers().find(s => s.id === source.serverId);
  return JSON.stringify([source.characterId, session.id, last?.id, last?.content?.length, server?.updatedAt, server?.enabled, server?.accessToken?.length, server?.discoveredTools?.length]);
}

let syncing: Promise<void> | null = null;

export function syncWakeServer(options: { force?: boolean } = {}): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    if (!toolEventEnabled() || !wakeServerAuth()) return;
    const state = await toolEventRequest({ action: 'status' });
    const sources = (state.sources || []).filter(s => s.mode === 'server');
    const uploaded = loadUploaded();
    const now = Date.now();
    for (const source of sources) {
      const sig = signature(source);
      const prev = uploaded[source.serverId];
      if (!options.force && prev && prev.characterId === source.characterId
        && ((prev.sig === sig && now - prev.at < REFRESH_MS) || now - prev.at < MIN_GAP_MS)) continue;
      try {
        const template = await buildWakeTemplate(source);
        await wakeServerApi(`/app/wake/templates/${encodeURIComponent(source.serverId)}`, { method: 'PUT', body: JSON.stringify(template) });
        uploaded[source.serverId] = { characterId: source.characterId, sig, at: now };
      } catch (e) {
        console.warn('[WakeServer] 底稿寄送失败：', source.serverId, e);
      }
    }
    const active = new Set(sources.map(s => s.serverId));
    for (const id of Object.keys(uploaded)) {
      if (active.has(id)) continue;
      try {
        await wakeServerApi(`/app/wake/templates/${encodeURIComponent(id)}/delete`, { method: 'POST', body: '{}' });
        delete uploaded[id];
      } catch { /* 下次再删 */ }
    }
    kvSet(UPLOADED_KEY, JSON.stringify(uploaded));
  })().catch(e => { console.warn('[WakeServer] 同步失败：', e); }).finally(() => { syncing = null; });
  return syncing;
}

/** 小手机开着就跑：启动、每 5 分钟、聊天有新消息（防抖）、切到后台、设置里保存来源时 */
export function startWakeServerSync(): () => void {
  let debounce = 0;
  const soon = (ms: number) => { window.clearTimeout(debounce); debounce = window.setTimeout(() => { void syncWakeServer(); }, ms); };
  const onMessages = () => soon(30_000);
  const onVisibility = () => { if (document.visibilityState === 'hidden') void syncWakeServer(); };
  const onForce = () => { void syncWakeServer({ force: true }); };
  const timer = window.setInterval(() => { void syncWakeServer(); }, 5 * 60_000);
  soon(10_000);
  window.addEventListener('chat-messages-updated', onMessages);
  window.addEventListener(WAKE_SERVER_SYNC_EVENT, onForce);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.clearTimeout(debounce);
    window.clearInterval(timer);
    window.removeEventListener('chat-messages-updated', onMessages);
    window.removeEventListener(WAKE_SERVER_SYNC_EVENT, onForce);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
