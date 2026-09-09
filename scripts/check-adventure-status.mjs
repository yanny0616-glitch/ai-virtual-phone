import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = file => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
function load(file, dependencies = {}, globals = {}) {
  const testModule = { exports: {} };
  const output = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(output, { module: testModule, exports: testModule.exports, console, structuredClone, ...globals,
    require: id => { if (id in dependencies) return dependencies[id]; throw new Error("Unexpected dependency: " + id); },
  }, { filename: file });
  return testModule.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const D = load("lib/adventure-status.ts");
const worldEdit = load("lib/adventure-world-edit.ts");
let sequence = 0;
const stamp = () => ({ id: `event_${sequence++}`, gameTime: "第3天 · 清晨", createdAt: "2026-09-08T10:00:00.000Z" });
let fields = D.palaceStatusFields();
fields[0].value = "常在";
const state = D.editAdventureStatus(undefined, true, fields, "补录已有剧情", stamp());
const original = JSON.stringify(state);
const event = { fieldId: "palace_rank", from: "常在", to: "贵人", kind: "occurred", reason: "救驾有功，正式册封", evidence: "皇帝正式下旨，晋封你为贵人，即日起生效。" };
const apply = (s, changes, extra = {}) => D.applyAdventureStatusChanges(s, changes, { ...stamp(), expectedRevision: s?.revision, narrative: event.evidence, ...extra });
assert.equal(D.adventureStatusContext(undefined), "");
assert.equal(D.adventureStatusInstruction(D.emptyAdventureStatus()), "");
assert.equal(apply(undefined, [event]).state, undefined);
const off = D.editAdventureStatus(state, false, state.fields, "暂时停用", stamp());
assert.equal(apply(off, [event]).state, off);
assert.equal(D.adventureStatusContext(off), "");
assert.equal(off.fields[0].value, "常在");
assert.equal(D.editAdventureStatus(off, true, off.fields, "恢复", stamp()).fields[0].value, "常在");

// Favor can reach the maximum without causing any rank change.
const favor = { ...event, fieldId: "palace_favor", from: 0, to: 100, evidence: "皇帝因你救驾而对你十分宠爱。" };
const favored = apply(state, [favor], { narrative: favor.evidence }).state;
assert.equal(favored.fields[2].value, 100);
assert.equal(favored.fields[0].value, "常在");
for (const text of ["皇帝许诺以后将晋封你为贵人。", "宫中传闻皇帝有意晋封你为贵人。", "大臣提议晋封你为贵人，尚未获准。"]) {
  const pending = { ...event, kind: "pending", evidence: text };
  const s = apply(state, [pending], { narrative: text }).state;
  assert.equal(s.fields[0].value, "常在");
  assert.equal(s.records.at(-1).status, "pending");
  assert.equal(apply(s, [{ ...pending }], { narrative: text }).state, s, "repeated proposals are not duplicated");
  const fulfilled = apply(s, [event]).state;
  assert.equal(fulfilled.fields[0].value, "贵人");
  assert.equal(fulfilled.records.at(-2).status, "resolved");
}
let promoted = apply(state, [event]).state;
assert.equal(promoted.fields[0].value, "贵人");
assert.equal(promoted.records.at(-1).evidence, event.evidence);
assert.equal(promoted.records.at(-1).gameTime, "第3天 · 清晨");
assert.equal(promoted.records.at(-1).source, "dm");
const demotion = { ...event, from: "贵人", to: "常在", evidence: "太后依授权颁旨，正式将你降为常在。", reason: "失职受罚" };
assert.equal(apply(promoted, [demotion], { narrative: demotion.evidence }).state.fields[0].value, "常在");

// Invalid/stale/unsubstantiated values never reach the stored state.
for (const invalid of [null, {}, { ...event, fieldId: "unknown" }, { ...event, from: "皇后" },
  { ...event, kind: "rumor" }, { ...event, evidence: "未出现在正文中的册封。" }, { ...event, reason: "" },
  { ...event, evidence: "晋封" }, { ...event, to: 5 }, { ...favor, to: 101 }, { ...favor, to: -1 },
  { ...favor, to: NaN }, { ...favor, to: Infinity }, { ...favor, to: "50" },
]) {
  const result = apply(state, [invalid]);
  assert.equal(result.state, state);
  assert.equal(result.warnings.length, 1);
}
assert.equal(apply(state, [event], { expectedRevision: state.revision - 1 }).state, state);
assert.equal(apply(state, {}, {}).state, state);
assert.equal(apply(state, [event], { narrative: "暂无册封，选项：求晋封" }).state, state);
const duplicate = apply(state, [event, event]);
assert.equal(duplicate.state.records.length, state.records.length + 1);
assert.equal(duplicate.warnings.length, 1);
const replayStamp = { ...stamp(), expectedRevision: state.revision, narrative: event.evidence };
const once = D.applyAdventureStatusChanges(state, [event], replayStamp).state;
assert.equal(D.applyAdventureStatusChanges(once, [event], { ...replayStamp, expectedRevision: once.revision }).state, once);
assert.equal(apply(promoted, [event]).state, promoted, "old from value prevents repeated promotion");
assert.equal(JSON.stringify(state), original, "domain must not mutate inputs");

// Manual correction and pending cancellation keep an audit trail.
const correctedFields = promoted.fields.map(f => f.id === "palace_rank" ? { ...f, value: "常在" } : f);
assert.throws(() => D.editAdventureStatus(promoted, true, correctedFields, "", stamp()), /原因/);
const corrected = D.editAdventureStatus(promoted, true, correctedFields, "刚才只是许诺，尚无旨意", stamp());
assert.equal(corrected.fields[0].value, "常在");
assert.equal(corrected.records.at(-1).source, "manual");
assert.equal(corrected.records.at(-2).to, "贵人");
const pending = apply(state, [{ ...event, kind: "pending" }]).state;
const dismissed = D.dismissStatusProposal(pending, pending.records.at(-1).id, "皇帝已收回许诺", stamp());
assert.equal(dismissed.fields[0].value, "常在");
assert.equal(dismissed.records.at(-2).status, "dismissed");
assert.throws(() => D.dismissStatusProposal(dismissed, pending.records.at(-1).id, "再次撤销", stamp()));
assert.throws(() => D.validateStatusFields([{ ...fields[2], min: 10, max: 0 }]));
assert.throws(() => D.validateStatusFields([...fields, fields[0]]));
assert.throws(() => D.editAdventureStatus(state, true, [], "清空", stamp()));
const otherWorld = D.editAdventureStatus(undefined, true, D.palaceStatusFields(), "另一世界", stamp());
assert.equal(otherWorld.fields[0].value, "待设定");
assert.match(D.adventureStatusContext(corrected), /最新存档/);
assert.match(D.adventureStatusInstruction(state), /提议、传闻、许诺/);
assert.deepEqual(plain(JSON.parse(JSON.stringify(corrected))), plain(corrected));
console.log("PASS domain: default off, enable/disable, independent worlds, favor vs rank, formal promotion/demotion, pending proposals, evidence, bounds/types, stale/replay protection, manual audit, immutable inputs.");

// Exercise actual save initialization/persistence with an isolated Dexie adapter.
const tables = new Map();
class FakeDexie {
  version() { return { stores: () => { for (const key of ["worlds", "saves", "themeBlobs"]) {
    if (!tables.has(key)) tables.set(key, new Map());
    const data = tables.get(key);
    this[key] = { toArray: async () => [...data.values()].map(row => structuredClone(row)), put: async row => { data.set(row.id, structuredClone(row)); }, delete: async id => data.delete(id) };
  } } }; }
}
const storageDeps = { "./adventure-world-edit": worldEdit, dexie: FakeDexie, "./llm-prompt-assembler": { formatChatTimestamp: x => x },
  "./kv-db": { kvGet: () => undefined, kvSet() {}, kvRemove() {}, registerKvMigration() {}, registerDynamicPrefix() {} },
  "./bilingual-prompt-defaults": {},
};
const storage = load("lib/map-storage.ts", storageDeps);
storage.saveMapWorld({ id: "world_1", initialCustomStatus: state, updatedAt: "today" });
const initialSave = storage.createInitialSave("world_1", "l1_0");
assert.deepEqual(plain(initialSave.customStatus), plain(state));
initialSave.customStatus.fields[0].value = "贵人";
assert.equal(storage.getMapWorld("world_1").initialCustomStatus.fields[0].value, "常在", "save must not mutate world template");
initialSave.customStatus = corrected;
initialSave.checkpoint = JSON.stringify({ ...initialSave, customStatus: state });
storage.saveGame(initialSave);
const reloadedStorage = load("lib/map-storage.ts", storageDeps, { window: {} });
await reloadedStorage.hydrateMapStorage();
assert.deepEqual(plain(reloadedStorage.getLatestSave("world_1").customStatus), plain(corrected));
assert.deepEqual(plain(tables.get("saves").get(initialSave.id).customStatus), plain(corrected));
assert.equal(JSON.parse(tables.get("saves").get(initialSave.id).checkpoint).customStatus.fields[0].value, "常在");
assert.equal(storage.createInitialSave("old_world", "l1_0").customStatus, undefined);
console.log("PASS saves: template deep copy, old save compatibility, exact persistence and checkpoint state.");

// Exercise both real DM call paths, including custom prompt overrides.
let response = {}; const calls = [];
const deps = {};
for (const match of read("lib/map-rpg-engine.ts").matchAll(/from ["']([^"']+)["']/g)) deps[match[1]] = {};
Object.assign(deps, {
  "./adventure-status": D,
  "./adventure-world-edit": worldEdit,
  "./api-helpers": { simpleLLMCall: async (_config, messages) => { calls.push(messages); return { content: typeof response === "string" ? response : JSON.stringify(response) }; } },
  "./map-storage": { getMapWorld: () => null, loadDMPrompts: () => ({ scene: "自定义场景提示", resolve: "自定义裁决提示" }), loadDMTokenConfig: () => ({}) },
  "./user-macro": { renderUserNameMacro: text => text, normalizeUserNameToMacro: text => text },
  "./token-counter": { estimateTokens: s => s.length },
});
const engine = load("lib/map-rpg-engine.ts", deps);
const ctx = { worldLore: "宫廷", currentLocation: "御花园", eventType: "talk", eventBrief: "赏花", companionNames: [], recentJournal: [], keyChoices: [], gameTime: "第3天", customStatus: state };
response = { narration: event.evidence, choices: [], status_changes: [event] };
for (const scene of [await engine.expandEvent(ctx, [], { defaultModel: "test" }), await engine.resolveRound(ctx, [], { defaultModel: "test" })]) {
  assert.deepEqual(plain(scene.statusChanges), [event]);
  assert.equal(apply(state, scene.statusChanges, { narrative: scene.dialogues.map(d => d.text).join("\n") }).state.fields[0].value, "贵人");
}
assert.match(calls[0][0].content, /自定义场景提示/);
assert.match(calls[1][0].content, /自定义裁决提示/);
assert.match(calls[0][0].content, /status_changes/);
assert.match(calls[1][1].content, /palace_rank/);
await engine.expandEvent({ ...ctx, customStatus: off }, [], { defaultModel: "test" });
assert.ok(!JSON.stringify(calls.at(-1)).includes("status_changes"));
assert.ok(!JSON.stringify(calls.at(-1)).includes("palace_rank"));
console.log("PASS DM integration: scene + resolve parse proposals, inject current state and protocol even with custom prompts; disabled requests unchanged.");

// Legacy JSON repair may alter punctuation, so repaired responses cannot update state.
response = JSON.stringify({ narration: event.evidence, status_changes: [event] }).replace(/}$/, ",}");
const repairedScene = await engine.expandEvent(ctx, [], { defaultModel: "test" });
assert.equal(repairedScene.statusChanges, null);
assert.equal(apply(state, repairedScene.statusChanges).state, state);
assert.ok(apply(state, repairedScene.statusChanges).warnings.length);

// Real companion payload builder receives latest state in normal, exit and preview calls.
Object.assign(deps["./character-storage"], { loadCharacters: () => [{ id: "emperor", name: "皇帝" }] });
Object.assign(deps["./settings-storage"], {
  loadBindingConfig: () => ({}), resolveBinding: () => ({ apiConfigId: "api" }), loadPresets: () => [],
  loadWorldBooks: () => [], loadRegexes: () => [], resolveUserIdentity: () => ({ name: "玩家" }),
  loadApiConfigs: () => [{ id: "api", apiKey: "fixture", defaultModel: "test" }],
});
Object.assign(deps["./map-storage"], { loadAdventureInteractionConfig: () => ({}) });
Object.assign(deps["./llm-prompt-assembler"], { assemblePromptPayload: () => [{ role: "user", content: "轮到你了" }] });
Object.assign(deps["./short-term-assembler"], { prepareShortTermContext: (_id, _app, input) => ({ truncatedHistory: input.history, wbActivationContext: "", recentBlocks: [], unifiedRecentItems: [] }) });
Object.assign(deps["./memory-service"], { retrieveMemoriesForPrompt: async () => null, retrieveCoreMemoriesForPrompt: async () => null });
Object.assign(deps["./memory-storage"], { loadMemoryConfig: () => ({}) });
Object.assign(deps["./calendar-storage"], { buildCalendarScheduleMarker: () => "" });
Object.assign(deps["./calendar-utils"], { getWeekStartIso: () => "" });
Object.assign(deps["./bilingual-prompt-defaults"], { resolveBilingualPrompt: () => "" });
const companionCalls = [];
Object.assign(deps["./chat-engine"], { previewMessagesForApi: (_api, _preset, messages) => messages,
  sendLLMRequest: async (_api, _preset, messages) => { companionCalls.push(messages); return '{"speech":"遵旨","action":"行礼"}'; },
});
for (const instruction of [undefined, "玩家离开，请回应"]) {
  const reply = await engine.companionDeclare("emperor", null, [], undefined, undefined, { instruction, customStatus: corrected });
  assert.equal(reply.speech, "遵旨");
  assert.match(companionCalls.at(-1).at(-1).content, /最新存档/);
  assert.match(companionCalls.at(-1).at(-1).content, /常在/);
}
const preview = await engine.previewAdventureCompanionPromptPayload("emperor", [], undefined, undefined, { customStatus: corrected });
assert.match(preview.messages.at(-1).content, /最新存档/);
const disabledPreview = await engine.previewAdventureCompanionPromptPayload("emperor", [], undefined, undefined, { customStatus: off });
assert.equal(disabledPreview.messages.length, 1);
console.log("PASS parsing + companion integration: repaired JSON cannot mutate state; normal/exit/preview get latest status; disabled adds no context.");

// Saved world edits are also visible to character prompts alongside custom status.
const editedWorld = { id: "world-edited", settingOverrides: { revision: 1, loreEdited: true, npcIds: ["npc_0"], aliases: {npc_0:["陆敬堂"]} }, skeleton: { world: {name:"大燕",lore:"皇帝尚无子嗣。"}, npcs:[{id:"npc_0",name:"陆承安",personality:"四十岁的首辅。"}] } };
Object.assign(deps["./map-storage"], { getMapWorld: id => id === editedWorld.id ? editedWorld : null });
const editedPreview = await engine.previewAdventureCompanionPromptPayload("emperor", [], undefined, undefined, { customStatus: corrected, worldId: editedWorld.id });
assert.match(editedPreview.messages.at(-1).content, /最新世界设定/);
assert.match(editedPreview.messages.at(-1).content, /陆承安/);
assert.match(editedPreview.messages.at(-2).content, /最新存档/);
const editedReply = await engine.companionDeclare("emperor", null, [], undefined, undefined, { worldId: editedWorld.id });
assert.equal(editedReply.speech, "遵旨");
assert.match(companionCalls.at(-1).at(-1).content, /皇帝尚无子嗣/);
console.log("PASS companion world edits: real request + preview include latest public settings and coexist with custom status.");
