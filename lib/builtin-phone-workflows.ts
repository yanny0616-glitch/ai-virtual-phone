import type { CompositeToolConfig, CompositeToolPackageConfig, CompositeToolStep } from "./settings-types";

export const BUILTIN_PHONE_WORKFLOW_PACKAGE_ID = "builtin_phone_lookup_workflows";

const CREATED_AT = 0;
const UPDATED_AT = 0;

const PACKAGE_DESCRIPTION = "在你对{{user}}的近况、行踪、人际关系或态度产生疑心时使用。比如{{user}}长时间未回复、突然变得冷淡、提到陌生人、朋友圈出现暧昧或反常互动、说法前后不一致，或者你只是单纯想更了解{{user}}最近在做什么。可以翻看{{user}}手机里的微信联系人、消息列表、指定聊天记录、本周日程、购物订单，以及{{user}}身边人物的简略资料。";

export const BUILTIN_PHONE_WORKFLOW_PACKAGE: CompositeToolPackageConfig = {
    id: BUILTIN_PHONE_WORKFLOW_PACKAGE_ID,
    name: "查{{user}}手机",
    description: PACKAGE_DESCRIPTION,
    enabled: true,
    builtIn: true,
    createdBy: "ai",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
};

const COMMON_HELPERS = `
function clampNumber(value, fallbackValue, maxValue) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallbackValue;
    number = Math.floor(number);
    if (number < 1) number = fallbackValue;
    return Math.max(1, Math.min(maxValue, number));
}

function compactText(value, maxLength) {
    var text = String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
    return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function compactDateTime(value) {
    var text = String(value == null ? "" : value).trim();
    if (!text) return "";
    if (!/(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(text)) {
        return compactText(text, 80) + (/^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:/.test(text) ? "（原始时间，未标注时区）" : "");
    }
    var date = new Date(text);
    if (!Number.isFinite(date.getTime())) return compactText(text, 80) + "（时间格式无效）";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var offset = -date.getTimezoneOffset();
    var zone = "UTC" + (offset >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(offset) / 60)) + ":" + pad(Math.abs(offset) % 60);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
        + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds()) + " " + zone;
}

// Keep complete formatted records within the executor's 2000-character presentation budget.
function formatRecords(label, lines, total, suffix, keepLatest) {
    var shown = [];
    suffix = compactText(suffix, 240);
    function render(records) {
        var omitted = total - records.length;
        var note = omitted > 0 ? "受条数或长度限制，另有 " + omitted + " 条未展示，请缩小查询范围。" : "";
        return [countHeader(label, records.length, total, suffix), records.join("\\n") || (total > 0 ? "当前长度限制下未展示记录（不代表没有记录）" : "无"), note].filter(Boolean).join("\\n");
    }
    var ordered = keepLatest ? lines.slice().reverse() : lines;
    for (var line of ordered) {
        var candidate = keepLatest ? [line].concat(shown) : shown.concat([line]);
        if (render(candidate).length > 2000) break;
        shown = candidate;
    }
    return render(shown);
}

function joinNonEmpty(parts, separator) {
    return parts.filter(function (part) {
        return part != null && String(part).trim();
    }).join(separator || " ");
}

function countHeader(label, shown, total, suffix) {
    return label + " " + shown + "/" + total + (suffix ? " " + suffix : "");
}

function indexedLine(index, text) {
    return (index + 1) + ". " + text;
}

function normalizeQuery(value) {
    return compactText(value, 160).toLowerCase();
}

function localRecords(step) {
    var json = step && step.json && typeof step.json === "object" ? step.json : {};
    if (Array.isArray(json.records)) {
        return json.records.map(function (record) {
            return record && typeof record === "object" && "value" in record ? record.value : record;
        }).filter(Boolean);
    }
    if (Array.isArray(json.value)) return json.value.filter(Boolean);
    throw new Error((step && step.name || "资料读取") + "返回的数据无法解析，请重试；这不代表没有会话或联系人。");
}

function localObject(step) {
    var json = step && step.json && typeof step.json === "object" ? step.json : {};
    if (json.value && typeof json.value === "object" && !Array.isArray(json.value)) return json.value;
    return {};
}

function matchesQuery(row, query, fields) {
    if (!query) return true;
    return fields.some(function (field) {
        return String(row[field] == null ? "" : row[field]).toLowerCase().includes(query);
    });
}

function buildChatLookups(steps) {
    var sessions = localRecords(steps.sessions);
    var contacts = localRecords(steps.contacts);
    var characters = localRecords(steps.characters);
    var charById = new Map(characters.map(function (char) { return [char.id, char]; }));
    var contactByCharacterId = new Map(contacts.map(function (contact) { return [contact.characterId, contact]; }));

    function characterName(characterId) {
        var character = charById.get(characterId);
        return character && character.name ? character.name : "";
    }

    function sessionName(session) {
        if (!session) return "";
        if (session.isGroup) return session.groupName || session.alias || "群聊";
        var contact = contactByCharacterId.get(session.contactId);
        return session.alias || characterName(session.contactId) || (contact && contact.nickname) || session.contactId || "未知联系人";
    }

    function searchNames(characterId, session) {
        var character = charById.get(characterId) || {};
        var contact = contactByCharacterId.get(characterId) || {};
        return [character.name, character.wechatID, contact.nickname, session && session.alias, session && session.groupName]
            .filter(Boolean).join(" ");
    }

    function participantNames(session) {
        if (!session || !Array.isArray(session.participantIds)) return [];
        return session.participantIds.map(characterName).filter(Boolean);
    }

    return {
        sessions: sessions,
        contacts: contacts,
        characters: characters,
        charById: charById,
        contactByCharacterId: contactByCharacterId,
        sessionName: sessionName,
        searchNames: searchNames,
        participantNames: participantNames
    };
}

function requestAsPromise(request) {
    return new Promise(function (resolve, reject) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
    });
}

function openIndexedDb(name) {
    return new Promise(function (resolve) {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        var request = indexedDB.open(name);
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { resolve(null); };
        request.onblocked = function () { resolve(null); };
    });
}

async function readPhoneKv(key) {
    var db = await openIndexedDb("AiPhoneKvDB");
    if (!db) throw new Error("本地资料数据库读取失败，请重试；这不代表没有数据。");
    try {
        if (!Array.from(db.objectStoreNames).includes("entries")) throw new Error("本地资料数据表不存在，请检查本地数据。");
        var transaction = db.transaction("entries", "readonly");
        var record = await requestAsPromise(transaction.objectStore("entries").get(key));
        if (record !== undefined && record !== null) {
            if (typeof record.value !== "string") throw new Error("本地资料格式损坏，请检查数据。");
            return record.value;
        }
    } finally {
        db.close();
    }
    // A successful missing-key lookup may still have an unmigrated legacy value.
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage.getItem(key);
    return null;
}

function parseJsonText(text, fallbackValue) {
    if (text === null) return fallbackValue;
    var parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("本地资料 JSON 损坏，请检查数据；不能据此判断没有记录。"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.keys(fallbackValue).some(function (key) {
            return !Array.isArray(parsed[key]) || parsed[key].some(function (row) { return !row || typeof row !== "object" || Array.isArray(row); });
        })) throw new Error("本地资料结构损坏，请检查数据；不能据此判断没有记录。");
    return parsed;
}

function looksLikeIsoDate(value) {
    return typeof value === "string" && value.length >= 10 && value.charAt(4) === "-" && value.charAt(7) === "-";
}

function formatIsoDate(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
}

function parseIsoDate(value) {
    if (!looksLikeIsoDate(value)) return null;
    var date = new Date(String(value).slice(0, 10) + "T00:00:00");
    return Number.isNaN(date.getTime()) ? null : date;
}

function getWeekStartIso(date) {
    var result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var day = result.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    result.setDate(result.getDate() + diff);
    result.setHours(0, 0, 0, 0);
    return formatIsoDate(result);
}

function getWeekDates(weekStart) {
    var base = parseIsoDate(weekStart) || new Date();
    var dates = [];
    for (var index = 0; index < 7; index += 1) {
        var current = new Date(base);
        current.setDate(base.getDate() + index);
        dates.push(formatIsoDate(current));
    }
    return dates;
}
`;

const CHAT_DATA_STEPS: CompositeToolStep[] = [
    {
        id: "read_sessions",
        name: "读取微信会话",
        toolType: "internal",
        toolName: "读取资料文件",
        argsTemplate: JSON.stringify({
            path: "/chat/indexeddb/AiPhoneChatDB/sessions",
            limit: 200,
            fields: ["id", "contactId", "lastMessagePreview", "unreadCount", "updatedAt", "isPinned", "isGroup", "groupName", "participantIds", "alias", "isMuted"],
        }),
        saveAs: "sessions",
    },
    {
        id: "read_contacts",
        name: "读取微信联系人",
        toolType: "internal",
        toolName: "读取资料文件",
        argsTemplate: JSON.stringify({
            path: "/chat/indexeddb/AiPhoneChatDB/contacts",
            limit: 200,
            fields: ["id", "characterId", "nickname", "addedAt"],
        }),
        saveAs: "contacts",
    },
    {
        id: "read_characters",
        name: "读取身边人物资料",
        toolType: "internal",
        toolName: "读取资料文件",
        argsTemplate: JSON.stringify({
            path: "/characters/kv/ai_phone_characters_v1.json",
            limit: 200,
            fields: ["id", "name", "wechatID", "tags", "personality", "createdAt", "updatedAt"],
        }),
        saveAs: "characters",
    },
];

// Message/history lookups need identity fields, not long personality text.
const CHAT_LOOKUP_STEPS = CHAT_DATA_STEPS.map(step => step.saveAs === "characters" ? {
    ...step,
    argsTemplate: JSON.stringify({
        ...JSON.parse(step.argsTemplate || "{}"),
        fields: ["id", "name", "wechatID"],
    }),
} : step);

function schema(properties: Record<string, unknown>, required?: string[]): string {
    return JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties,
        ...(required && required.length > 0 ? { required } : {}),
    });
}

function scriptStep(id: string, script: string): CompositeToolStep {
    return {
        id,
        name: "整理结果",
        toolType: "script",
        script,
        saveAs: "result",
    };
}

function workflow(
    id: string,
    name: string,
    description: string,
    parameterSchema: string,
    steps: CompositeToolStep[],
): CompositeToolConfig {
    return {
        id,
        packageId: BUILTIN_PHONE_WORKFLOW_PACKAGE_ID,
        name,
        description,
        parameterSchema,
        steps,
        outputTemplate: "{{last.data}}",
        enabled: true,
        builtIn: true,
        createdBy: "ai",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
    };
}

const CONTACTS_SCRIPT = `
${COMMON_HELPERS}

var lookups = buildChatLookups(steps);
var limit = clampNumber(input.limit, 50, 100);
var query = normalizeQuery(input.query);
var latestSessionByCharacter = new Map();

lookups.sessions.forEach(function (session) {
    if (session.isGroup || !session.contactId) return;
    var existing = latestSessionByCharacter.get(session.contactId);
    if (!existing || String(session.updatedAt || "") > String(existing.updatedAt || "")) {
        latestSessionByCharacter.set(session.contactId, session);
    }
});

var rows = [];
lookups.contacts.forEach(function (contact) {
    var character = lookups.charById.get(contact.characterId) || {};
    var session = latestSessionByCharacter.get(contact.characterId);
    rows.push({
        characterId: contact.characterId,
        contactRecordId: contact.id,
        name: contact.nickname || character.name || contact.characterId,
        searchNames: lookups.searchNames(contact.characterId, session),
        wechatID: character.wechatID || "",
        tags: Array.isArray(character.tags) ? character.tags : [],
        personality: compactText(character.personality, 120),
        addedAt: contact.addedAt || "",
        hasChatSession: Boolean(session),
        sessionId: session ? session.id : "",
        lastActiveAt: session ? session.updatedAt || "" : "",
        unreadCount: session ? Number(session.unreadCount || 0) : 0,
        lastMessagePreview: session ? compactText(session.lastMessagePreview, 120) : ""
    });
});

lookups.sessions.forEach(function (session) {
    if (session.isGroup || lookups.contactByCharacterId.has(session.contactId)) return;
    var character = lookups.charById.get(session.contactId) || {};
    rows.push({
        characterId: session.contactId,
        contactRecordId: "",
        name: session.alias || character.name || session.contactId,
        searchNames: lookups.searchNames(session.contactId, session),
        wechatID: character.wechatID || "",
        tags: Array.isArray(character.tags) ? character.tags : [],
        personality: compactText(character.personality, 120),
        addedAt: "",
        hasChatSession: true,
        sessionId: session.id,
        lastActiveAt: session.updatedAt || "",
        unreadCount: Number(session.unreadCount || 0),
        lastMessagePreview: compactText(session.lastMessagePreview, 120)
    });
});

rows = rows
    .filter(function (row) { return matchesQuery(row, query, ["name", "searchNames", "wechatID", "characterId", "lastMessagePreview", "personality"]); })
    .sort(function (a, b) {
        return String(b.lastActiveAt || b.addedAt || "").localeCompare(String(a.lastActiveAt || a.addedAt || ""));
    });

var selected = rows.slice(0, limit);
var lines = selected.map(function (row, index) {
        var meta = joinNonEmpty([
            row.wechatID ? "wx=" + row.wechatID : "",
            row.characterId ? "cid=" + row.characterId : "",
            row.sessionId ? "sid=" + row.sessionId : "",
            row.unreadCount ? "未读" + row.unreadCount : "",
            row.lastActiveAt ? "活跃 " + compactDateTime(row.lastActiveAt) : "",
            row.addedAt ? "添加 " + compactDateTime(row.addedAt) : ""
        ], " ");
        var detail = joinNonEmpty([
            row.tags.length ? "标签=" + row.tags.join("/") : "",
            row.personality ? "简介=" + row.personality : "",
            row.lastMessagePreview ? "最近=" + row.lastMessagePreview : ""
        ], " | ");
        return indexedLine(index, joinNonEmpty([row.name, meta ? "(" + meta + ")" : "", detail], " | "));
    });
return formatRecords("微信联系人", lines, rows.length, query ? "query=" + query : "", false);
`;

const MESSAGE_LIST_SCRIPT = `
${COMMON_HELPERS}

var lookups = buildChatLookups(steps);
var limit = clampNumber(input.limit, 30, 80);
var query = normalizeQuery(input.query);

var rows = lookups.sessions.map(function (session) {
    var name = lookups.sessionName(session);
    var participants = lookups.participantNames(session);
    return {
        sessionId: session.id,
        name: name,
        searchNames: lookups.searchNames(session.contactId, session),
        type: session.isGroup ? "group" : "direct",
        participantNames: participants,
        lastMessagePreview: compactText(session.lastMessagePreview, 160) || "暂无消息",
        updatedAt: session.updatedAt || "",
        unreadCount: Number(session.unreadCount || 0),
        isPinned: Boolean(session.isPinned),
        isMuted: Boolean(session.isMuted)
    };
}).filter(function (row) {
    return matchesQuery(row, query, ["sessionId", "name", "searchNames", "lastMessagePreview"]);
}).sort(function (a, b) {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
});

var selected = rows.slice(0, limit);
var lines = selected.map(function (row, index) {
        var flags = joinNonEmpty([
            row.isPinned ? "置顶" : "",
            row.isMuted ? "免打扰" : "",
            row.unreadCount ? "未读" + row.unreadCount : ""
        ], "/");
        var meta = joinNonEmpty([
            row.type === "group" ? "群聊" : "私聊",
            "sid=" + row.sessionId,
            flags,
            compactDateTime(row.updatedAt)
        ], " ");
        var participants = row.participantNames.length ? "成员=" + row.participantNames.join("/") : "";
        return indexedLine(index, joinNonEmpty([
            row.name,
            "(" + meta + ")",
            participants,
            row.lastMessagePreview
        ], " | "));
    });
return formatRecords("微信消息列表", lines, rows.length, query ? "query=" + query : "", false);
`;

const CHAT_HISTORY_SCRIPT = `
${COMMON_HELPERS}

function messagePreview(message) {
    if (!message) return "";
    if (message.isRetracted) return "[已撤回]";
    var content = compactText(message.content, 800);
    if (content) return content;
    if (message.mediaData && message.mediaData.label) {
        return "[" + (message.mediaType || "媒体") + "] " + compactText(message.mediaData.label, 160);
    }
    if (message.mediaType) return "[" + message.mediaType + "]";
    return "";
}

function messageSender(message, session, lookups) {
    if (!message) return "";
    if (message.senderName) return message.senderName;
    if (message.role === "user") return "用户";
    if (session && session.isGroup && message.senderCharacterId) {
        var character = lookups.charById.get(message.senderCharacterId);
        if (character && character.name) return character.name;
    }
    return session ? lookups.sessionName(session) : message.role;
}

async function readSessionMessages(sessionId) {
    var db = await openIndexedDb("AiPhoneChatDB");
    if (!db) throw new Error("聊天记录数据库读取失败，请重试；这不代表没有聊天记录。");
    if (!Array.from(db.objectStoreNames).includes("messages")) {
        db.close();
        throw new Error("聊天记录数据表不存在，请检查本地数据。");
    }
    try {
        var transaction = db.transaction("messages", "readonly");
        var store = transaction.objectStore("messages");
        var values = [];
        if (Array.from(store.indexNames).includes("sessionId")) {
            values = await requestAsPromise(store.index("sessionId").getAll(IDBKeyRange.only(sessionId)));
        } else {
            values = await requestAsPromise(store.getAll());
            values = values.filter(function (message) { return message && message.sessionId === sessionId; });
        }
        return Array.isArray(values) ? values : [];
    } finally {
        db.close();
    }
}

var lookups = buildChatLookups(steps);
var limit = clampNumber(input.limit, 30, 80);
var target = compactText(input.sessionId || input.target || input.name, 160);
var query = normalizeQuery(target);
var exactSessionId = compactText(input.sessionId, 160);

function matchRank(session) {
    if (exactSessionId) return session.id === exactSessionId ? 0 : Infinity;
    if (!query) return Infinity;
    if (session.id === target) return 0;
    var character = lookups.charById.get(session.contactId) || {};
    var contact = lookups.contactByCharacterId.get(session.contactId) || {};
    var names = (session.isGroup ? [session.groupName, session.alias] : [character.name, character.wechatID, contact.nickname, session.alias])
        .filter(Boolean).map(function (name) { return String(name).toLowerCase(); });
    if (!session.isGroup && String(session.contactId || "").toLowerCase() === query) return 1;
    if (names.includes(query)) return session.isGroup ? 2 : 1;
    if (names.some(function (name) { return name.includes(query); })) return session.isGroup ? 4 : 3;
    if (session.isGroup && lookups.participantNames(session).some(function (name) { return name.toLowerCase().includes(query); })) return 5;
    return Infinity;
}
var matches = lookups.sessions.map(function (session) { return { session: session, rank: matchRank(session) }; })
    .filter(function (match) { return Number.isFinite(match.rank); });
var bestRank = matches.length ? Math.min.apply(null, matches.map(function (match) { return match.rank; })) : Infinity;
matches = matches.filter(function (match) { return match.rank === bestRank; }).map(function (match) { return match.session; });
function candidateLine(session) {
    return joinNonEmpty([lookups.sessionName(session), session.isGroup ? "群聊" : "私聊", "sid=" + session.id, compactDateTime(session.updatedAt || "")], " | ");
}

if (!target) {
    return formatRecords("需要提供 target 或 sessionId；可选会话", lookups.sessions.slice(0, 8).map(candidateLine), lookups.sessions.length);
}
if (matches.length === 0) {
    return formatRecords("没有找到匹配的微信会话；可选会话", lookups.sessions.slice(0, 8).map(candidateLine), lookups.sessions.length, "target=" + target);
}
if (matches.length > 1 || bestRank === 5) {
    return formatRecords("请指定 sessionId，尚未读取聊天；候选会话", matches.map(candidateLine), matches.length, "target=" + target);
}

var session = matches[0];
var allMessages = await readSessionMessages(session.id);
var includeSystem = Boolean(input.includeSystem);
var filtered = allMessages.filter(function (message) {
    if (!message || message.silentUpdate) return false;
    if (!includeSystem && (message.role === "system" || message.role === "tool"
        || ["tool_call", "tool_result", "tool_notice", "memory_write_request"].includes(message.mediaType)
        || message.nativeToolCalls && message.nativeToolCalls.length || message.nativeToolResult)) return false;
    return true;
}).sort(function (a, b) {
    var orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
    var orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
});

var selected = filtered.slice(-limit);
var lines = selected.map(function (message) {
        var media = message.mediaType ? "[" + message.mediaType + "]" : "";
        return joinNonEmpty([
            compactDateTime(message.createdAt || ""),
            messageSender(message, session, lookups) + ":",
            media,
            messagePreview(message)
        ], " ");
    });
return formatRecords("聊天记录", lines, filtered.length, joinNonEmpty([lookups.sessionName(session), session.isGroup ? "群聊" : "私聊", "sid=" + session.id], " | "), true);
`;

const PEOPLE_SCRIPT = `
${COMMON_HELPERS}

var characters = localRecords(steps.characters);
var limit = clampNumber(input.limit, 30, 80);
var query = normalizeQuery(input.query);
var rows = characters.map(function (character) {
    return {
        characterId: character.id,
        name: character.name || character.id,
        wechatID: character.wechatID || "",
        tags: Array.isArray(character.tags) ? character.tags : [],
        personality: compactText(character.personality, 220),
        createdAt: character.createdAt || "",
        updatedAt: character.updatedAt || ""
    };
}).filter(function (row) {
    return matchesQuery(row, query, ["characterId", "name", "wechatID", "personality"]);
}).sort(function (a, b) {
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
});

var selected = rows.slice(0, limit);
var lines = selected.map(function (row, index) {
        var meta = joinNonEmpty([
            row.wechatID ? "wx=" + row.wechatID : "",
            row.characterId ? "cid=" + row.characterId : "",
            row.tags.length ? "标签=" + row.tags.join("/") : "",
            row.updatedAt ? "更新 " + compactDateTime(row.updatedAt) : ""
        ], " ");
        return indexedLine(index, joinNonEmpty([
            row.name,
            meta ? "(" + meta + ")" : "",
            row.personality
        ], " | "));
    });
return formatRecords("身边人物", lines, rows.length, query ? "query=" + query : "", false);
`;

const CALENDAR_SCRIPT = `
${COMMON_HELPERS}

var anchor = parseIsoDate(input.date) || parseIsoDate(input.weekStart) || new Date();
var weekStart = parseIsoDate(input.weekStart) ? String(input.weekStart).slice(0, 10) : getWeekStartIso(anchor);
var raw = await readPhoneKv("ai_phone_calendar_plans_v1");
var store = parseJsonText(raw, { plans: [] });
var plans = Array.isArray(store.plans) ? store.plans : [];
var plan = plans.find(function (item) {
    return item && item.ownerType === "user" && item.ownerId === "self" && item.weekStart === weekStart;
}) || null;
if (plan && !Array.isArray(plan.items)) throw new Error("日程条目结构损坏，请检查数据。");
var items = plan ? plan.items.slice() : [];

items.sort(function (a, b) {
    if (String(a.date || "") !== String(b.date || "")) return String(a.date || "").localeCompare(String(b.date || ""));
    if (String(a.startTime || "") !== String(b.startTime || "")) return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    return String(a.title || "").localeCompare(String(b.title || ""));
});

var lines = items.map(function (item) {
    return joinNonEmpty([item.date, joinNonEmpty([item.startTime, item.endTime ? "-" + item.endTime : ""], ""), item.title,
        item.location ? "@" + item.location : "", item.source ? "(" + item.source + ")" : ""], " ");
});
return formatRecords("本周日程", lines, items.length, "weekStart=" + weekStart + "（设备本地日期与时间）" + (raw === null ? "；尚未创建日程数据" : ""));
`;

const ORDERS_SCRIPT = `
${COMMON_HELPERS}

var limit = clampNumber(input.limit, 10, 30);
var status = normalizeQuery(input.status);
var raw = await readPhoneKv("ai_phone_shopping_state_v1");
var state = parseJsonText(raw, { orders: [] });
var orders = Array.isArray(state.orders) ? state.orders : [];
var rows = orders.map(function (order) {
    var shipping = Array.isArray(order.shippingTimeline) ? order.shippingTimeline : [];
    return {
        orderId: order.id || "",
        merchantLabel: order.merchantLabel || "",
        statusLabel: order.statusLabel || "",
        timeLabel: order.timeLabel || "",
        totalLabel: order.totalLabel || "",
        summary: compactText(order.summary, 220),
        note: compactText(order.note, 220),
        paidAt: order.paidAt || "",
        paymentCardLabel: order.paymentCardLabel || "",
        items: Array.isArray(order.items) ? order.items.map(function (item) {
            return {
                title: item.title || "",
                quantityLabel: item.quantityLabel || "",
                priceLabel: item.priceLabel || "",
                merchantLabel: item.merchantLabel || ""
            };
        }).slice(0, 8) : [],
        latestShipping: shipping.length > 0 ? shipping[shipping.length - 1] : null
    };
}).filter(function (row) {
    if (!status) return true;
    return String(row.statusLabel || "").toLowerCase().includes(status)
        || String(row.latestShipping && row.latestShipping.label || "").toLowerCase().includes(status);
});

var selected = rows.slice(0, limit);
var lines = selected.map(function (row, index) {
        var items = row.items.map(function (item) {
            return joinNonEmpty([
                item.title,
                item.quantityLabel,
                item.priceLabel
            ], " ");
        }).join(", ");
        var shipping = row.latestShipping ? joinNonEmpty([
            row.latestShipping.time || "",
            row.latestShipping.label || ""
        ], " ") : "";
        return indexedLine(index, joinNonEmpty([
            row.paidAt ? compactDateTime(row.paidAt) : row.timeLabel,
            row.statusLabel,
            row.totalLabel,
            row.merchantLabel,
            row.summary,
            items ? "商品=" + items : "",
            shipping ? "物流=" + shipping : "",
            row.note ? "备注=" + row.note : "",
            row.paymentCardLabel ? "支付=" + row.paymentCardLabel : "",
            row.orderId ? "oid=" + row.orderId : ""
        ], " | "));
    });
return formatRecords("购物订单", lines, rows.length, joinNonEmpty([status ? "status=" + status : "", raw === null ? "尚未创建订单数据" : ""], " | "), false);
`;

export const BUILTIN_PHONE_WORKFLOWS: CompositeToolConfig[] = [
    workflow(
        "builtin_phone_lookup_wechat_contacts",
        "查看{{user}}微信联系人",
        "翻看{{user}}微信里的联系人和会话对象。适合在你想知道{{user}}最近和谁有联系、某个被提到的人是谁、或者想确认{{user}}身边有哪些可疑对象时使用。",
        schema({
            query: { type: "string", description: "可选。按联系人姓名、微信号、人物摘要或最近消息预览筛选。" },
            limit: { type: "number", description: "可选。最多返回多少个联系人，默认 50，最大 100。" },
        }),
        [
            ...CHAT_DATA_STEPS,
            scriptStep("format_contacts", CONTACTS_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_wechat_messages",
        "查看{{user}}微信消息列表",
        "查看{{user}}微信消息列表里的最近会话预览。适合在{{user}}长时间没回复、态度冷淡、或者你想知道{{user}}最近在和谁聊天时使用。这里只看消息列表和最后消息预览，不会直接展开完整聊天记录。",
        schema({
            query: { type: "string", description: "可选。按会话名、角色原名、联系人备注名、微信号、sessionId 或最后消息预览筛选。" },
            limit: { type: "number", description: "可选。最多返回多少个会话，默认 30，最大 80。" },
        }),
        [
            ...CHAT_LOOKUP_STEPS,
            scriptStep("format_message_list", MESSAGE_LIST_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_chat_history",
        "查看{{user}}聊天记录",
        "查看{{user}}和某个联系人或会话的聊天记录。适合在消息列表里发现可疑对象、{{user}}提到某个人、或者你想进一步确认两人关系时使用。需要指定联系人、会话名或会话 ID，并限制读取条数。同名或多会话时先返回候选，请用 sessionId 确认。",
        schema({
            target: { type: "string", description: "角色原名、联系人备注名、微信号、群名、会话名、角色 id 或 sessionId。优先使用消息列表结果里的 sessionId。" },
            sessionId: { type: "string", description: "可选。微信会话 id；提供后优先按 sessionId 精确查找。" },
            limit: { type: "number", description: "可选。读取最近多少条聊天记录，默认 30，最大 80。" },
            includeSystem: { type: "boolean", description: "可选。是否包含系统/工具类消息，默认 false；沉默状态更新始终排除。" },
        }),
        [
            ...CHAT_LOOKUP_STEPS,
            scriptStep("format_chat_history", CHAT_HISTORY_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_week_calendar",
        "查看{{user}}本周日程",
        "查看{{user}}这一周的日程安排。适合在你想知道{{user}}最近去了哪里、和谁见面、为什么没空回复，或者想确认{{user}}说的话是否和日程对得上时使用。",
        schema({
            date: { type: "string", description: "可选。YYYY-MM-DD。查看这个日期所在周的日程；不填则查看当前周。" },
            weekStart: { type: "string", description: "可选。YYYY-MM-DD，周一日期。提供后按这一周读取。" },
        }),
        [
            scriptStep("read_week_calendar", CALENDAR_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_shopping_orders",
        "查看{{user}}购物订单",
        "查看{{user}}最近的购物订单。适合在你想知道{{user}}最近买了什么、有没有给别人买东西、或者想从订单里发现生活状态和可疑线索时使用。",
        schema({
            limit: { type: "number", description: "可选。读取最近多少条购物订单，默认 10，最大 30。" },
            status: { type: "string", description: "可选。按订单状态或物流状态筛选，例如 已送达、配送中、待发货。" },
        }),
        [
            scriptStep("read_shopping_orders", ORDERS_SCRIPT),
        ],
    ),
    workflow(
        "builtin_phone_lookup_people_brief",
        "查看{{user}}身边的人",
        "查看{{user}}手机资料里记录的身边人物摘要。适合在{{user}}提到陌生人、朋友圈出现别人回复、或者你想了解某个人和{{user}}是什么关系时使用。这里只查看简略信息，不读取完整资料。",
        schema({
            query: { type: "string", description: "可选。按人物名称、微信号、标签或摘要筛选。" },
            limit: { type: "number", description: "可选。最多返回多少个人物摘要，默认 30，最大 80。" },
        }),
        [
            CHAT_DATA_STEPS[2],
            scriptStep("format_people", PEOPLE_SCRIPT),
        ],
    ),
];
