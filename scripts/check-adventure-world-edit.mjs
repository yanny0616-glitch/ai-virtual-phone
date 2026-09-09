import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
const read = f => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
function load(file, dependencies = {}) {
  const testModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
    { module: testModule, exports: testModule.exports, structuredClone, console, require: id => { if (!(id in dependencies)) throw Error("Missing stub " + id); return dependencies[id]; } }, { filename: file });
  return testModule.exports;
}
const D = load("lib/adventure-world-edit.ts");
const plain = x => JSON.parse(JSON.stringify(x));
const fixture = () => ({ id: "w1", createdAt: "old", updatedAt: "old", renderedMap: { layout: "keep" }, initialCustomStatus: { enabled: true }, skeleton: {
  world: { name: "大燕", lore: "皇帝已有三个皇子。" },
  richRegions: [{ id: "palace", l1_name_cn: "紫光殿", l1_npc: { name: "陆敬堂", personality: "六十二岁的内阁首辅。", role: "info" }, l2_nodes: [{ name: "御书房", npc: { name: "秦衡", personality: "三十五岁的翰林学士。", role: "info" } }], l3_nodes: [] }],
  npcs: [{ id: "npc_0", name: "陆敬堂", personality: "六十二岁的内阁首辅。", locationRegion: "palace", locationNode: "紫光殿", role: "info", relatedQuestIds: ["q1"] }, { id: "npc_1", name: "秦衡", personality: "三十五岁的翰林学士。", locationRegion: "palace", locationNode: "御书房", role: "info", relatedQuestIds: [] }],
  dmDossier: { foreshadowing: [], plotTwist: "secret", endgame: "secret", hiddenTruth: "NEVER_SEND_SECRET", npcSecrets: { npc_0: "NEVER_SEND_NPC_SECRET" } },
  mainQuest: { synopsis: "陆敬堂的任务不改", stages: [] }, sideQuests: [], encounterPool: [], mapInput: { regions: [] }, partyStats: {},
} });
const world = fixture(), original = JSON.stringify(world);
const changes = [
  { target: "world", field: "lore", value: "皇帝尚无子嗣。", reason: "按要求去掉皇子设定" },
  { target: "npc_0", field: "name", value: "陆承安", reason: "修改姓名" },
  { target: "npc_0", field: "personality", value: "四十岁的内阁首辅，保留原有立场。", reason: "按要求改年龄" },
];
const plan = D.planWorldSettingEdit(world, { changes });
assert.equal(JSON.stringify(world), original, "preview cannot mutate world");
assert.equal(plan.changes[1].before, "陆敬堂");
const next = D.applyWorldSettingEdit(world, plan, "new");
assert.equal(next.skeleton.world.lore, "皇帝尚无子嗣。");
assert.equal(next.skeleton.npcs[0].name, "陆承安");
assert.equal(next.skeleton.richRegions[0].l1_npc.name, "陆承安");
assert.equal(next.skeleton.richRegions[0].l1_npc.personality, next.skeleton.npcs[0].personality);
for (const key of ["mapInput", "mainQuest", "sideQuests", "encounterPool", "partyStats", "dmDossier"]) assert.deepEqual(plain(next.skeleton[key]), plain(world.skeleton[key]));
assert.deepEqual(plain(next.renderedMap), plain(world.renderedMap));
assert.deepEqual(plain(next.initialCustomStatus), plain(world.initialCustomStatus));
assert.equal(next.settingOverrides.aliases.npc_0[0], "陆敬堂");
assert.equal(D.findCurrentWorldNpc(next, "陆敬堂").name, "陆承安");
assert.equal(D.worldSettingContext(world), "");
assert.match(D.worldSettingContext(next), /陆承安/);
assert.match(D.worldSettingContext(next), /皇帝尚无子嗣/);
assert.ok(!D.worldSettingContext(next).includes("NEVER_SEND"));
assert.ok(!D.worldSettingContext(next, false).includes("四十岁的"), "DM alias note does not duplicate full NPC profiles");
assert.throws(() => D.applyWorldSettingEdit(next, plan, "later"), /已变化/);
assert.throws(() => D.applyWorldSettingEdit({ ...world, id: "other" }, plan, "later"), /已变化/);
for (const bad of [{ changes: [] }, { changes, deleteNpc: true }, { changes: [{ ...changes[0], field: "stages" }] },
  { changes: [{ ...changes[1], target: "npc_missing" }] }, { changes: [{ ...changes[0], value: "" }] },
  { changes: [{ ...changes[0], before: "model invented before" }] }, { changes: [{ ...changes[1], value: "秦衡" }] },
  { changes: [changes[0], changes[0]] }, { changes: [{ ...changes[0], reason: "" }] }]) assert.throws(() => D.planWorldSettingEdit(world, bad));
const duplicate = fixture();duplicate.skeleton.richRegions[0].l2_nodes.push({ name: "紫光殿", npc: { ...duplicate.skeleton.richRegions[0].l1_npc } });
assert.throws(() => D.planWorldSettingEdit(duplicate, { changes: [changes[1]] }), /无法唯一/);
const l2 = D.applyWorldSettingEdit(world, D.planWorldSettingEdit(world, { changes: [{ target: "npc_1", field: "personality", value: "寡言的学士。", reason: "改变性格" }] }), "new");
assert.equal(l2.skeleton.richRegions[0].l2_nodes[0].npc.personality, "寡言的学士。");
const again = D.applyWorldSettingEdit(next, D.planWorldSettingEdit(next, { changes: [{ ...changes[1], value: "陆怀远" }] }), "later");
assert.deepEqual(plain(again.settingOverrides.aliases.npc_0), ["陆敬堂", "陆承安"]);
console.log("PASS world edits: immutable preview, schema limits, canonical/map NPC sync, duplicate/ambiguous identities, aliases, progress/map/secret preservation, stale previews.");

let reply, calls = [];
const generator = load("lib/adventure-world-edit-generator.ts", { "./adventure-world-edit": D, "./api-helpers": {
  simpleLLMCall: async (config, messages, options) => { calls.push({ config, messages, options }); return typeof reply === "function" ? reply() : reply; },
} });
const api = { apiKey: "fixture", defaultModel: "test" };
let controller = new AbortController();
reply = { content: JSON.stringify({ changes }) };
const generated = await generator.generateWorldSettingEdit(world, "皇帝无子，陆敬堂改名陆承安并改成四十岁", api, controller.signal);
assert.equal(generated.changes.length, 3);
assert.ok(!JSON.stringify(calls[0].messages).includes("NEVER_SEND"));
assert.match(calls[0].messages[1].content, /npc_0/);
assert.equal(calls[0].options.signal, controller.signal);
assert.equal(JSON.stringify(world), original);
controller.abort();
await assert.rejects(generator.generateWorldSettingEdit(world, "改年龄", api, controller.signal), /取消/);
controller = new AbortController();
reply = () => { controller.abort(); return { content: JSON.stringify({ changes }) }; };
await assert.rejects(generator.generateWorldSettingEdit(world, "改年龄", api, controller.signal), /取消/);
for (const bad of [{ content: null, error: "连接失败" }, { content: "broken JSON" }, { content: JSON.stringify({ changes }), wasTruncated: true }]) {
  reply = bad;await assert.rejects(generator.generateWorldSettingEdit(world, "改年龄", api, new AbortController().signal));
}
console.log("PASS generation: one request, existing IDs/public context only, preview-only, abort/errors/truncation.");

// Actual storage method with failure injection; no caller cache update before a successful write.
const db = new Map([[world.id, structuredClone(world)]]);let fail = false;
class FakeDexie {
  version() { return { stores: () => { this.worlds = { get: async id => structuredClone(db.get(id)), put: async value => { if(fail) throw Error("write failed");db.set(value.id,structuredClone(value)); } }; } }; }
  transaction(_mode, _table, work) { return work(); }
}
const storage = load("lib/map-storage.ts", { dexie: FakeDexie, "./adventure-world-edit": D,
  "./llm-prompt-assembler": {}, "./kv-db": {registerKvMigration(){},registerDynamicPrefix(){}}, "./bilingual-prompt-defaults": {},
});
fail = true;
await assert.rejects(storage.saveWorldSettingPlan(plan), /write failed/);
assert.equal(storage.getMapWorld(world.id), null);
assert.equal(db.get(world.id).skeleton.world.lore, world.skeleton.world.lore);
fail = false;
await storage.saveWorldSettingPlan(plan);
assert.equal(storage.getMapWorld(world.id).skeleton.world.lore, "皇帝尚无子嗣。");
await assert.rejects(storage.saveWorldSettingPlan(plan), /已变化/);
console.log("PASS persistence: actual reviewed-save path awaits write, failure leaves world/cache unchanged, stale save rejected.");

// Actual DM request entry points refresh a cached eventContext after editing.
const deps = {};
for (const match of read("lib/map-rpg-engine.ts").matchAll(/from ["']([^"']+)["']/g)) deps[match[1]] = {};
const status = load("lib/adventure-status.ts");
let dmCalls = [];
Object.assign(deps, {
  "./adventure-world-edit": D, "./adventure-status": status,
  "./api-helpers": {simpleLLMCall:async(_api,messages)=>{dmCalls.push(messages);return {content:'{"narration":"继续剧情","choices":[],"paragraphs":[],"closing":"结束"}'};}},
  "./map-storage": {getMapWorld:id=>id===next.id?next:null,loadDMPrompts:()=>({}),loadDMTokenConfig:()=>({})},
  "./token-counter": {estimateTokens:s=>s.length},
  "./user-macro": {renderUserNameMacro:s=>s,normalizeUserNameToMacro:s=>s},
});
// Make a valid map-only scene fixture without changing the original edit fixture.
next.skeleton.richRegions[0].geography = "plains";
const engine = load("lib/map-rpg-engine.ts", deps);
const ctx = {worldId:world.id,worldLore:world.skeleton.world.lore,richRegions:world.skeleton.richRegions,npcName:"陆敬堂",npcPersonality:"旧资料",currentLocation:"紫光殿",eventType:"talk",eventBrief:"继续交谈",companionNames:[],recentJournal:[],keyChoices:[],gameTime:"第3天"};
const refreshed = engine.refreshDMWorldSettings(ctx);
assert.equal(refreshed.npcName,"陆承安");assert.match(refreshed.npcPersonality,/四十岁/);
assert.equal(ctx.npcName,"陆敬堂","refresh does not mutate stored event snapshot");
await engine.expandEvent(ctx,[],api);await engine.resolveRound(ctx,[],api);await engine.generateEnding(ctx,api);
for(const messages of dmCalls){const text=JSON.stringify(messages);assert.match(text,/皇帝尚无子嗣/);assert.match(text,/四十岁/);assert.match(text,/最新世界设定/);assert.ok(!text.includes("六十二岁的"));}
assert.equal(engine.refreshDMWorldSettings({...ctx,worldId:"unedited"}).npcName,"陆敬堂");
console.log("PASS DM integration: scene, resolve (including free-chat path) and ending read latest world/NPC; prior event snapshot stays intact.");
