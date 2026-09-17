// 排错清单：打开页面时现查。只读本机配置和状态；联网的只有「实际连一次」和自托管版本检查。
import type { ApiConfig, PresetConfig } from "./settings-types";
import {
    loadApiConfigs, loadBindingConfig, loadImageGenerationSettings, loadPresets, loadRegexes,
    loadUserIdentities, loadVoiceConfigs, resolveBinding, resolveUserIdentity,
} from "./settings-storage";
import { fixApiBaseUrl } from "./api-url";
import { getApiLogs, getApiLogStorageChars } from "./api-log-store";
import { simpleLLMCall } from "./api-helpers";
import { loadCharacters } from "./character-storage";
import { loadMomentsConfig } from "./moments-storage";
import { loadChatPluginErrors, loadChatPlugins } from "./chat-plugin-storage";
import { loadInstalledCustomApps } from "./custom-app-storage";
import { isCloudBackupConfigured, loadCloudBackupConfig } from "./cloud-backup/config";
import { loadCloudBackupState } from "./cloud-backup/engine";
import { getOfflinePushState, loadPushQuietHours } from "./push-client";
import { isPersonalPushCloudActive } from "./personal-push-cloud";
import { loadKeepAlive } from "./weixin-storage";
import { readThemeProfile } from "./theme-storage";
import { getStorageHealth, refreshStorageEstimate, storageUsageRatio } from "./storage-health";
import { chatDb } from "./chat-db";
import { REASONING_LEVELS } from "./reasoning-effort";

export type CheckState = "ok" | "bad" | "warn" | "q";
export type SettingsPageId = "api" | "voice" | "imageGeneration" | "presets" | "regex" | "data" | "binding" | "cloud" | "about" | "identity";
export type CheckAction = { label: string; page?: SettingsPageId; run?: "test-chat" | "retry-storage" | "request-notify" | "persist" | "reload" };
export type CheckStep = { state: CheckState; text: string; sub?: string; action?: CheckAction };
export type Symptom = { id: string; title: string; steps: CheckStep[]; aside?: string; codes?: ReadonlyArray<readonly [string, string]> };
export type CategoryId = "chat" | "proactive" | "moments" | "media" | "data" | "display" | "apps";
export type Category = { id: CategoryId; title: string; symptoms: Symptom[] };
export type TestResult = { ok: boolean; message: string; at: number };

const ERROR_CODES: ReadonlyArray<readonly [RegExp, string, string]> = [
    [/\b401\b/, "401", "Key 不对或过期了。重新粘贴一次，前后别带空格。"],
    [/\b403\b/, "403", "没权限：这个 Key 用不了这个模型，或中转站限制了地区。"],
    [/\b404\b/, "404", "地址或模型名不对。对照 API 设置里「实际会请求」那一行。"],
    [/\b429\b/, "429", "额度或频率到顶了。等一会儿，或换 Key、充值。"],
    [/\b400\b/, "400", "参数不对：常见是上下文太长，或推理深度、温度这个模型不收。"],
    [/\b(500|502|503|504|529)\b/, "5xx", "服务那边出问题了，过几分钟再试；中转站就换一家。"],
    [/Failed to fetch|NetworkError|Load failed|网络/i, "网络错误", "中转站不让网页直接访问（跨域），或 http:// 地址被浏览器拦下。"],
    [/timeout|timed out|超时|aborted/i, "超时", "模型想太久或网络慢：推理深度调低，或换快一点的模型。"],
];

function explainApiError(raw: string): { code: string; hint: string } | null {
    for (const [re, code, hint] of ERROR_CODES) if (re.test(raw)) return { code, hint };
    return null;
}

const ok = (text: string, sub?: string, action?: CheckAction): CheckStep => ({ state: "ok", text, sub, action });
const bad = (text: string, sub?: string, action?: CheckAction): CheckStep => ({ state: "bad", text, sub, action });
const warn = (text: string, sub?: string, action?: CheckAction): CheckStep => ({ state: "warn", text, sub, action });
const q = (text: string, sub?: string, action?: CheckAction): CheckStep => ({ state: "q", text, sub, action });
const go = (page: SettingsPageId, label = "去改"): CheckAction => ({ label, page });

function hhmm(at: number): string {
    const d = new Date(at);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ago(at: number): string {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    return `${days} 天前`;
}

function formatBytes(n: number): string {
    return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

function isIOS(): boolean {
    return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
    return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

// 预设条目开关可能写在 prompts[].enabled，也可能写在 prompt_order 里（嵌套结构不固定）
function orderDisabled(order: unknown, id: string): boolean {
    if (!Array.isArray(order)) return false;
    return order.some((e) => {
        const o = e as { identifier?: unknown; enabled?: unknown; order?: unknown };
        return (o?.identifier === id && o.enabled === false) || orderDisabled(o?.order, id);
    });
}

function promptOff(preset: PresetConfig | undefined, id: string): boolean {
    if (!preset) return false;
    const prompt = preset.prompts?.find(p => p.identifier === id);
    if (!prompt) return false;
    return prompt.enabled === false || orderDisabled(preset.prompt_order, id);
}

type Env = {
    configs: ApiConfig[];
    chatConfig: ApiConfig | null;
    chatConfigMissing: boolean;
    preset: PresetConfig | undefined;
    binding: ReturnType<typeof loadBindingConfig>;
};

function loadEnv(): Env {
    const configs = loadApiConfigs();
    const binding = loadBindingConfig();
    const slot = resolveBinding(binding);
    const chatConfig = slot.apiConfigId ? configs.find(c => c.id === slot.apiConfigId) ?? null : null;
    const presets = loadPresets();
    return {
        configs,
        chatConfig,
        chatConfigMissing: !!slot.apiConfigId && !chatConfig,
        preset: presets.find(p => p.id === slot.presetId) ?? presets[0],
        binding,
    };
}

function candidateConfig(env: Env): ApiConfig | null {
    return env.chatConfig ?? env.configs[0] ?? null;
}

export async function testDefaultChat(): Promise<TestResult> {
    const config = candidateConfig(loadEnv());
    const at = Date.now();
    if (!config) return { ok: false, message: "没有 API 配置", at };
    try {
        const r = await simpleLLMCall(config, [{ role: "user", content: "你好" }], { temperature: 0.2, max_tokens: 4096, label: "排错清单测试" });
        if (r.error || !r.content) {
            const raw = r.error || "模型返回了空内容";
            const hint = explainApiError(raw);
            return { ok: false, message: hint ? `${hint.code} · ${hint.hint}` : raw.slice(0, 120), at };
        }
        return { ok: true, message: `模型回：${r.content.replace(/\s+/g, " ").trim().slice(0, 40)}`, at };
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const hint = explainApiError(raw);
        return { ok: false, message: hint ? `${hint.code} · ${hint.hint}` : raw.slice(0, 120), at };
    }
}

function apiSteps(env: Env, test: TestResult | null): CheckStep[] {
    const steps: CheckStep[] = [];
    if (!env.configs.length) return [bad("还没有任何 API 配置", "先在 API 设置里新增一套", go("api", "去加"))];
    if (env.chatConfigMissing) steps.push(bad("默认绑定的 API 配置已经被删了", undefined, go("binding")));
    else if (!env.chatConfig) steps.push(bad("配置绑定里没选默认 API", "没单独绑 API 的角色一发消息就报错", go("binding")));
    const c = candidateConfig(env)!;
    const name = c.name || c.provider;
    if (env.chatConfig) steps.push(ok(`默认用「${name}」`, c.defaultModel || undefined));
    if (!c.apiKey.trim()) steps.push(bad(`「${name}」的 Key 是空的`, undefined, go("api")));
    else if (/\s/.test(c.apiKey)) steps.push(warn("Key 里有空格或换行", "重新粘贴一次，前后别带空格", go("api")));
    else steps.push(ok("Key 已填"));
    const fix = fixApiBaseUrl(c.provider, c.baseUrl);
    if (fix.empty) {
        steps.push(c.provider === "Custom" ? bad("自定义服务商没填地址", undefined, go("api")) : ok("地址用官方的"));
    } else if (fix.invalid) {
        steps.push(bad("地址格式不对", c.baseUrl, go("api")));
    } else {
        const problem = fix.notes.find(n => n.tone === "bad");
        steps.push(problem ? bad(problem.text, fix.base, go("api")) : ok("地址能拼成请求", fix.base + fix.parts.tail));
    }
    if (!c.defaultModel.trim()) steps.push(bad("没填模型名", undefined, go("api")));
    if (c.reasoningEffort) {
        const label = REASONING_LEVELS.find(l => l.key === c.reasoningEffort)?.label ?? c.reasoningEffort;
        steps.push(ok(`推理深度设在「${label}」`, "一直报 400 时先改回「按服务商默认」试试"));
    }
    const last = getApiLogs().filter(l => l.channel !== "qa").at(-1);
    if (last) {
        const at = Date.parse(last.timestamp);
        if (last.failed) {
            const hint = explainApiError(last.rawResponse || "");
            steps.push(bad(`最近一次请求失败${hint ? `：${hint.code}` : ""}`, `${hhmm(at)} · ${hint ? hint.hint : (last.rawResponse || "").slice(0, 80)}`, go("api")));
        } else {
            steps.push(ok("最近一次请求成功", `${hhmm(at)}${last.characterName ? ` · ${last.characterName}` : ""}`));
        }
    }
    if (!test) steps.push(q("实际连一次", "用默认 API 发一句「你好」，几秒出结果", { label: "测试", run: "test-chat" }));
    else if (test.ok) steps.push(ok("实际连通了", test.message));
    else steps.push(bad("实际连一次失败", test.message, { label: "再测", run: "test-chat" }));
    return steps;
}

function chatCategory(env: Env, test: TestResult | null): Category {
    const c = candidateConfig(env);
    const p = env.preset;
    const ownApi = env.binding.characterBindings.filter(b => b.defaults?.apiConfigId).length;
    const enabled = p?.enabled_generation_parameters;
    const has = (k: string) => !enabled || (enabled as string[]).includes(k);

    const truncated: CheckStep[] = [];
    if (p) {
        const max = p.openai_max_tokens;
        if (has("max_tokens") && max > 0 && max < 1500) truncated.push(warn(`预设最多只让回 ${max} token`, "调到 4000 以上", go("presets", "去调")));
        else truncated.push(ok(`预设回复上限 ${has("max_tokens") && max > 0 ? `${max} token` : "没设"}`));
    }
    if (c?.reasoningEffort && ["high", "xhigh", "max"].includes(c.reasoningEffort)) {
        truncated.push(q("推理深度偏高：思考也算在回复长度里", "上限不够会自动抬高；还是断就调低一档", go("api", "去看")));
    }

    const chars = loadCharacters();
    const thin = chars.filter(ch => (ch.persona || "").trim().length < 50);
    const ooc: CheckStep[] = [
        thin.length
            ? warn(`${thin.length} 个角色人设不到 50 字`, thin.slice(0, 4).map(ch => ch.name).join("、"))
            : ok(chars.length ? `${chars.length} 个角色人设都写了` : "还没有角色"),
    ];
    const oocOff = [["charDescription", "角色设定"], ["charPersonality", "角色性格"], ["personaDescription", "用户设定"], ["worldInfoBefore", "世界书"]]
        .filter(([id]) => promptOff(p, id)).map(([, label]) => label);
    ooc.push(oocOff.length ? bad(`预设里关着：${oocOff.join("、")}`, undefined, go("presets")) : ok("预设里角色设定、性格、用户设定都开着"));
    if (p && p.openai_max_context > 0 && p.openai_max_context < 8000) {
        ooc.push(warn(`上下文只有 ${p.openai_max_context} token`, "聊久了早期设定会被挤出去，调到 32000 以上", go("presets", "去调")));
    }

    const activeRules = loadRegexes().flatMap(r => r.rules).filter(r => !r.disabled).length;
    const leak: CheckStep[] = [q(`正则规则启用了 ${activeRules} 条`, "露出来的标签可以加一条正则去掉", go("regex", "去看"))];
    if (c && c.provider !== "Anthropic" && c.provider !== "Google" && /r1|reasoner|thinking|qwq/i.test(c.defaultModel)) {
        leak.unshift(warn("这个模型会先想再答", "有的中转站把思考写成 <think>…</think> 混进正文"));
    }

    const rambling: CheckStep[] = [];
    if (c) {
        rambling.push(c.preventEmptyGenerateRambling === true
            ? ok("「防胡言乱语」开着")
            : warn("「防胡言乱语」关着", "没有你的新消息时模型容易自说自话", go("api")));
    }
    if (p && has("temperature")) {
        rambling.push(p.temperature > 1.2 ? warn(`温度 ${p.temperature} 偏高`, "1.0 左右更稳", go("presets", "去调")) : ok(`温度 ${p.temperature}`));
    }

    return {
        id: "chat",
        title: "聊天回复",
        symptoms: [
            {
                id: "no-reply",
                title: "发消息 TA 没反应 / 一直转圈",
                steps: apiSteps(env, test),
                aside: ownApi ? `有 ${ownApi} 个角色单独绑了 API。只有某个角色没反应时，去配置绑定看 TA 用的是哪套。` : undefined,
            },
            {
                id: "error-codes",
                title: "报错码对照表",
                steps: [],
                codes: ERROR_CODES.map(([, code, hint]) => [code, hint] as const),
            },
            { id: "truncated", title: "回复说一半就断了", steps: truncated, aside: "开了流式时网络一断也会只剩半截，点「重新生成」就行。" },
            { id: "ooc", title: "回复不像人设 / 忘了设定", steps: ooc, aside: "聊得很长以后忘事是正常的：开长期记忆，或把关键设定写进世界书。" },
            { id: "leak", title: "思考过程、奇怪标签露在正文里", steps: leak, aside: "看到 <状态>、[xxx] 这类标签，多半是预设要求的格式模型没照做：重新生成一次，或在预设里找对应的格式条目。" },
            { id: "rambling", title: "重复、胡言乱语、自说自话", steps: rambling, aside: "反复说同一句：预设里的「频率惩罚」调到 0.3 左右；换个模型也常见效。" },
        ],
    };
}

async function proactiveCategory(env: Env): Promise<Category> {
    const push = await getOfflinePushState().catch(() => "unsupported" as const);
    const pushStep = push === "on"
        ? ok("锁屏推送开着", "页面关了也能收到")
        : push === "off"
            ? warn("锁屏推送没开", "页面关掉后 TA 就没法主动找你。在聊天的「离线推送与定时消息」里打开")
            : warn("这个浏览器不支持推送", isIOS() ? "iPhone 要从主屏幕图标打开才支持" : undefined);

    const wakeOff = [["chat_followup", "追发"], ["chat_timed_wake", "定时想起你"], ["chat_idle_reconnect", "久不聊来找你"]]
        .filter(([id]) => promptOff(env.preset, id)).map(([, label]) => label);
    const noProactive: CheckStep[] = [
        wakeOff.length ? warn(`预设里关着：${wakeOff.join("、")}`, undefined, go("presets")) : ok("预设里主动相关的条目都开着"),
        pushStep,
        loadKeepAlive() ? ok("后台保活开着") : q("后台保活关着", "在设置首页打开，切到后台时页面不容易被挂起"),
    ];

    const noPush: CheckStep[] = [];
    if (isIOS() && !isStandalone()) noPush.push(bad("现在是在 Safari 里打开的", "iPhone 要先「添加到主屏幕」，从主屏幕图标打开才收得到推送"));
    const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    if (perm === "denied") noPush.push(bad("通知权限被拒了", isIOS() ? "去 iPhone 设置 → 通知 → float 打开" : "去浏览器的网站设置里允许通知"));
    else if (perm === "default") noPush.push(warn("还没允许通知", undefined, { label: "允许", run: "request-notify" }));
    else if (perm === "granted") noPush.push(ok("通知权限已允许"));
    noPush.push(pushStep);
    noPush.push(isPersonalPushCloudActive()
        ? ok("个人推送云已部署")
        : q("没部署个人推送云", "可选：部署后推送更稳，挂念也能在云端到点生成", go("cloud", "去部署")));
    const quiet = loadPushQuietHours();
    if (quiet) noPush.push(q(`免打扰时段 ${quiet}`, "这段时间不推送"));

    return {
        id: "proactive",
        title: "主动消息与推送",
        symptoms: [
            { id: "no-proactive", title: "TA 从不主动找我", steps: noProactive, aside: "主动消息由 TA 自己判断，不是每次都来。想让 TA 按日程定时想起你，用官方 APP「挂念」。" },
            { id: "no-push", title: "锁屏收不到推送", steps: noPush, aside: "重新部署或更新之后推送偶尔会掉：到推送开关那里关掉再打开一次。" },
            { id: "push-late", title: "推送来得晚 / 点开是空的", steps: [pushStep], aside: "iPhone 开着低电量模式、专注模式时推送会被延后。推送只负责叫醒你，点开后页面要加载两三秒才拉到新消息，刚点开是空的属正常。" },
        ],
    };
}

function imageSteps(): CheckStep[] {
    const s = loadImageGenerationSettings();
    if (!s.enabled) return [bad("生图没开", undefined, go("imageGeneration", "去开"))];
    if (s.provider === "novelai") {
        return [s.novelai?.apiKey ? ok("用 NovelAI 生图") : bad("NovelAI 的 Key 是空的", undefined, go("imageGeneration"))];
    }
    const preset = s.openaiPresets?.find(p => p.id === s.activeOpenAiPresetId);
    const key = preset?.apiKey ?? s.apiKey;
    const model = preset?.model ?? s.model;
    if (!key) return [bad("生图的 Key 是空的", undefined, go("imageGeneration"))];
    if (!model) return [bad("没填生图模型", undefined, go("imageGeneration"))];
    return [ok(`生图用「${preset?.name || "OpenAI 格式"}」`, model)];
}

function momentsCategory(env: Env): Category {
    const mc = loadMomentsConfig();
    const chars = loadCharacters();
    const disabled = chars.filter(c => mc.autoPostDisabledCharacterIds.includes(c.id));
    const rhythm = loadChatPlugins().find(p => p.manifest.id === "moments-rhythm");
    const momentsSlot = resolveBinding(env.binding, undefined, "moments");

    const noPost: CheckStep[] = [
        mc.postIntervalMinHours >= 72
            ? warn(`最快也要 ${mc.postIntervalMinHours} 小时才发一次`, "朋友圈设置里调短")
            : ok(`每 ${mc.postIntervalMinHours}–${mc.postIntervalMaxHours} 小时发一次`),
    ];
    if (disabled.length) noPost.push(warn(`${disabled.length} 个角色关了自动发帖`, disabled.slice(0, 4).map(c => c.name).join("、")));
    if (rhythm?.enabled) noPost.push(ok("插件「朋友圈节奏」开着", "发帖时间由它按 TA 的作息安排"));
    if (promptOff(env.preset, "moments_post")) noPost.push(bad("预设里「发朋友圈」条目关着", undefined, go("presets")));
    if (momentsSlot.apiConfigId && !env.configs.some(c => c.id === momentsSlot.apiConfigId)) {
        noPost.push(bad("朋友圈绑定的 API 配置已经被删了", undefined, go("binding")));
    }

    const noComment: CheckStep[] = [
        mc.commentProb <= 0 ? warn("评论概率是 0") : ok(`评论概率 ${Math.round(mc.commentProb * 100)}%`),
        mc.likeProb <= 0 ? warn("点赞概率是 0") : ok(`点赞概率 ${Math.round(mc.likeProb * 100)}%`),
    ];
    const commentOff = [["moments_comment", "评论"], ["moments_reply", "回复评论"]].filter(([id]) => promptOff(env.preset, id)).map(([, l]) => l);
    if (commentOff.length) noComment.push(bad(`预设里关着：${commentOff.join("、")}`, undefined, go("presets")));

    return {
        id: "moments",
        title: "朋友圈",
        symptoms: [
            { id: "no-post", title: "TA 从不发朋友圈", steps: noPost, aside: "只在小手机开着时按时间检查，关掉期间攒下的不会一次补发。" },
            { id: "no-comment", title: "不评论、不点赞、不回我", steps: noComment, aside: "TA 回你的评论有几秒到几分钟的延迟，朋友圈设置里能调。" },
            { id: "no-photo", title: "朋友圈配图不出", steps: imageSteps(), aside: "配图要生图开着，而且配不配图是 TA 发帖时自己决定的。" },
        ],
    };
}

function mediaCategory(env: Env): Category {
    const s = loadImageGenerationSettings();
    const refs = Object.keys(s.characterReferences ?? {}).length;
    const look: CheckStep[] = [
        refs ? ok(`${refs} 个角色设了参考图`) : warn("没有角色设参考图", "在生图设置里给角色传一张", go("imageGeneration")),
        s.appearanceOn === false ? warn("「角色出镜时加长相」关着", undefined, go("imageGeneration", "去开")) : ok("角色出镜时会加长相"),
    ];

    const voices = loadVoiceConfigs();
    const voice = voices.find(v => v.id === resolveBinding(env.binding).voiceConfigId);
    const voiceSteps: CheckStep[] = [];
    if (!voices.length) voiceSteps.push(warn("还没有语音配置", undefined, go("voice", "去加")));
    else if (!voice) voiceSteps.push(warn("配置绑定里没选默认语音", undefined, go("binding")));
    else if (!voice.enableTTS) voiceSteps.push(warn(`「${voice.name || voice.provider}」没开语音合成`, undefined, go("voice")));
    else if (!voice.apiKey) voiceSteps.push(bad("语音的 Key 是空的", undefined, go("voice")));
    else voiceSteps.push(ok(`默认语音用「${voice.name || voice.provider}」`));

    return {
        id: "media",
        title: "生图与语音",
        symptoms: [
            { id: "image-fail", title: "生图失败 / 一直转圈", steps: imageSteps(), aside: "中转站得支持生图接口；一直转圈多半是模型在排队，等一两分钟。" },
            { id: "image-look", title: "画出来不像 TA", steps: look, aside: "点开图片 → 编辑，能直接改「长相」和「此刻」两行再重新生图。" },
            { id: "voice-fail", title: "语音发不出 / 没声音", steps: voiceSteps, aside: isIOS() ? "iPhone 静音键打开时网页不出声；每次打开小手机后第一次播放要先点一下屏幕。" : "浏览器要先有一次点击才允许播放声音。" },
        ],
    };
}

async function dataCategory(): Promise<Category> {
    await refreshStorageEstimate();
    const health = getStorageHealth();
    const ratio = storageUsageRatio(health);
    const count = await chatDb.messages.count().catch(() => -1);
    const persisted = await navigator.storage?.persisted?.().catch(() => undefined);
    const identities = loadUserIdentities();
    const current = resolveUserIdentity();
    const backupCfg = loadCloudBackupConfig();
    const backup = loadCloudBackupState();
    const configured = isCloudBackupConfigured(backupCfg);
    const lastBackup = backup.lastCreatedAt ? Date.parse(backup.lastCreatedAt) : 0;

    const lost: CheckStep[] = [];
    if (identities.length > 1) lost.push(q(`你有 ${identities.length} 个身份，默认是「${current?.name || identities[0].name}」`, "有的聊天绑在别的身份上，切过去看看", go("identity", "去看")));
    if (count >= 0) lost.push(ok(`本机存着 ${count.toLocaleString()} 条聊天消息`));
    if (persisted === false) lost.push(warn("浏览器没答应长期保存", "空间紧时可能被自动清掉", { label: "申请", run: "persist" }));
    else if (persisted) lost.push(ok("浏览器答应了长期保存"));
    lost.push(!configured
        ? warn("没配云端备份", undefined, go("data", "去配"))
        : lastBackup ? ok(`上次云端备份：${ago(lastBackup)}`) : warn("配了云端备份，还没成功过一次", undefined, go("data", "去看")));

    const unsaved = health.failures.length + health.overflow;
    const write: CheckStep[] = [];
    if (health.connectionLost) write.push(bad("数据库连接断了", "点重连；不行就完全关掉小手机再打开", { label: "重连", run: "retry-storage" }));
    const lastFail = health.failures.at(-1);
    write.push(unsaved
        ? bad(`这次打开后有 ${unsaved} 处没存上`, lastFail ? `最近：${hhmm(lastFail.at)} 的${lastFail.label}（${lastFail.error}）` : undefined, { label: "重试", run: "retry-storage" })
        : ok("这次打开后没有写入失败"));
    if (ratio !== null && health.usage !== null && health.quota !== null) {
        const text = `已用 ${formatBytes(health.usage)} / 约 ${formatBytes(health.quota)}`;
        write.push(ratio >= 0.8 ? warn(text, "快满了，清一清图片和旧记录", go("data", "去清理")) : ok(text));
    } else {
        write.push(q("浏览器没说空间有多大"));
    }

    const slow: CheckStep[] = [];
    if (count > 30000) slow.push(warn(`聊天消息有 ${count.toLocaleString()} 条`, "特别多时打开会慢：导出备份后清掉旧的", go("data", "去看")));
    else if (count >= 0) slow.push(ok(`聊天消息 ${count.toLocaleString()} 条，不算多`));
    const logChars = getApiLogStorageChars();
    slow.push(logChars > 3_000_000 ? warn(`调用日志占了约 ${Math.round(logChars / 1e6)} MB`, "在「用量」APP 里把日志条数调小") : ok("调用日志不大"));
    const css = readThemeProfile().globalCustomCSS?.length ?? 0;
    if (css > 30000) slow.push(warn(`自定义 CSS 有 ${css.toLocaleString()} 字`, "动画、模糊特效多也会卡"));

    const backupSteps: CheckStep[] = [configured ? ok("云端备份配好了") : warn("没配云端备份", undefined, go("data", "去配"))];
    if (backup.lastResult === "error") backupSteps.push(bad("上次备份失败", (backup.lastError || "").slice(0, 100), go("data", "去看")));
    else if (backup.lastResult === "anomaly") backupSteps.push(warn("上次备份体积异常，没覆盖旧备份", "去数据管理看一眼", go("data", "去看")));
    if (configured && lastBackup && Date.now() - lastBackup > 7 * 86_400_000) backupSteps.push(warn(`上次备份是 ${ago(lastBackup)}`, "打开小手机时会自动备份，也能手动来一次", go("data", "去备份")));

    return {
        id: "data",
        title: "数据与存储",
        symptoms: [
            { id: "lost-history", title: "聊天记录不见了", steps: lost, aside: "数据存在当前这个浏览器里：换浏览器、开无痕、换了网址都看不到原来的。" },
            { id: "write-fail", title: "提示存不上", steps: write },
            { id: "slow", title: "越来越卡", steps: slow, aside: "图片多的话去数据管理压缩图片；iPhone 上关掉其他标签页也有用。" },
            { id: "backup", title: "备份与恢复", steps: backupSteps, aside: "恢复在数据管理里选一个时间点。" },
        ],
    };
}

async function displayCategory(): Promise<Category> {
    const update: CheckStep[] = [];
    try {
        const res = await fetch("/api/self-host/update", { cache: "no-store" });
        const d = await res.json() as { ok?: boolean; current?: string; building?: boolean; updateAvailable?: boolean; latest?: { sha?: string } | null };
        if (d.ok) {
            if (d.updateAvailable) update.push(warn("服务器还没装上最新版", `当前 ${d.current} → ${d.latest?.sha ?? "?"}`, go("about", "去更新")));
            else if (d.building) update.push(q("GitHub 还在构建新版本", "一般 5～8 分钟后能更新"));
            else update.push(ok("服务器已是最新", d.current));
        }
    } catch {
        /* 不是自托管部署 */
    }
    update.push(navigator.serviceWorker?.controller
        ? q("页面有离线缓存", "完全关掉小手机再打开（iPhone 从后台上滑关掉），或点刷新", { label: "刷新", run: "reload" })
        : q("刷新一次页面", undefined, { label: "刷新", run: "reload" }));

    const css = readThemeProfile().globalCustomCSS?.trim().length ?? 0;
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-text-scale"));
    const ui: CheckStep[] = [css ? warn(`正在用自定义 CSS（${css.toLocaleString()} 字）`, "界面乱了先去外观里把全局 CSS 清空试试") : ok("没用自定义 CSS")];
    if (scale && Math.abs(scale - 1) > 0.01) ui.push(q(`字号缩放 ×${scale}`, "在外观里调回 1"));

    const install: CheckStep[] = [isStandalone()
        ? ok("从主屏幕图标打开的")
        : isIOS()
            ? warn("在 Safari 里打开的", "分享 → 添加到主屏幕：全屏更像 App，也才收得到推送")
            : q("在浏览器里打开的", "浏览器菜单 → 安装应用 / 添加到主屏幕")];

    return {
        id: "display",
        title: "显示与安装",
        symptoms: [
            { id: "no-update", title: "更新了却没变化", steps: update },
            { id: "broken-ui", title: "界面错乱、字太大太小", steps: ui, aside: "只有某个 APP 乱：多半是那个 APP 的主题或 CSS，先换回默认主题看看。" },
            { id: "install", title: "装到主屏幕", steps: install },
        ],
    };
}

function appsCategory(): Category {
    const apps = loadInstalledCustomApps();
    const plugins = loadChatPlugins();
    const since = Date.now() - 3 * 86_400_000;
    const errors = loadChatPluginErrors().filter(e => e.level === "error" && Date.parse(e.at) > since);
    const latestByPlugin = new Map<string, typeof errors[number]>();
    for (const e of errors) latestByPlugin.set(e.pluginId, e);

    const pluginSteps: CheckStep[] = [ok(`启用了 ${plugins.filter(p => p.enabled).length}/${plugins.length} 个聊天插件`)];
    for (const [id, e] of latestByPlugin) {
        const name = plugins.find(p => p.manifest.id === id)?.manifest.name || id;
        pluginSteps.push(bad(`插件「${name}」出过错`, `${e.where}：${e.message}`.slice(0, 120)));
    }

    const guaNian = apps.find(a => a.manifest?.id === "gua.nian" || a.id === "gua.nian");
    const gnSteps: CheckStep[] = [];
    if (!guaNian) gnSteps.push(q("没装挂念", "在 APP 市场里装"));
    else {
        gnSteps.push(ok(`挂念 ${guaNian.version}`));
        gnSteps.push(isPersonalPushCloudActive()
            ? ok("个人推送云已部署", "关着页面也能到点想起你")
            : warn("没部署个人推送云", "不部署的话只有开着小手机时才会到点想起你", go("cloud", "去部署")));
    }

    return {
        id: "apps",
        title: "APP 与插件",
        symptoms: [
            {
                id: "app-blank",
                title: "自定义 APP 白屏 / 打不开",
                steps: [ok(`装了 ${apps.length} 个 APP`, apps.slice(0, 6).map(a => a.name).join("、") || undefined)],
                aside: "先去 APP 市场看有没有新版本；还白屏就卸载重装，卸载时别勾删除数据。官方 APP 会随小手机自动提示升级。",
            },
            { id: "plugin", title: "聊天插件没生效 / 出错", steps: pluginSteps, aside: "出错的插件先关掉，看问题还在不在。" },
            { id: "gua-nian", title: "挂念不工作", steps: gnSteps, aside: "挂念里有日志，到点没动静先看那里写了什么。" },
        ],
    };
}

export async function runTroubleshootChecks(options: { test?: TestResult | null } = {}): Promise<Category[]> {
    const env = loadEnv();
    const [proactive, data, display] = await Promise.all([proactiveCategory(env), dataCategory(), displayCategory()]);
    return [
        chatCategory(env, options.test ?? null),
        proactive,
        momentsCategory(env),
        mediaCategory(env),
        data,
        display,
        appsCategory(),
    ];
}
