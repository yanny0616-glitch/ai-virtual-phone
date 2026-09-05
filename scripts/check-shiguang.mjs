import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
function load(file, modules = {}, globals = {}) {
    const source = ts.transpileModule(fs.readFileSync(new URL(file, root), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(source, { exports, require: id => id in modules ? modules[id] : require(id), console, Date, ...globals }, { filename: file });
    return exports;
}
const types = load("lib/shiguang-types.ts");
const tokens = load("lib/token-counter.ts");
const domain = load("lib/shiguang-domain.ts", { "./shiguang-types": types, "./token-counter": tokens });
const memoryTypes = load("lib/memory-types.ts");
const now = "2026-09-05T20:00:00.000Z";
const sources = [0,1,2,3].map(i => ({ id: `m${i}`, sourceApp: "chat", sourceDetail: "direct", sessionId: "s1", authorType: i % 2 ? "character" : "user", responseBatchId: i % 2 ? `batch${i}` : undefined, timestamp: `2026-09-05T20:0${i}:00.000Z`, content: i % 2 ? "好，9月11日晚确认去海边的安排。" : "我们9月12日去海边，改计划请提前告诉我。" }));
const item = { title: "去海边前确认安排", summary: "约好12日去海边，11日晚确认。", reason: "临时变动会不安", story: "双方约定提前确认安排", categories: ["约定与承诺", "喜好与边界"], details: [{ label: "确认", value: "2026-09-11" }], significance: "提前商量", stableSummary: "用户希望计划变动时提前商量。", recallSummary: "约好9月12日去海边，9月11日晚确认。", keywords: ["海边", "出行"], dueAt: "2026-09-11", status: "pending", followup: "等待确认", sourceIds: ["s1", "s2"] };
const parse = (items, old = [], refs = sources) => domain.parseShiguangResult(JSON.stringify({ memories: items }), refs, old, "c1", now).entries;
let checks = 0;
function check(name, fn) { fn(); checks++; console.log("✓", name); }
check("same reply's bubbles count once; rounds are independent of UI time clusters", () => {
    assert.equal(domain.countShiguangRounds([sources[0], sources[1], { ...sources[1], id: "bubble2" }, sources[2], sources[3]]), 2);
    assert.equal(domain.countShiguangRounds(sources.map(s => ({ ...s, sourceDetail: "group" }))), 0);
    assert.equal(domain.countShiguangRounds(sources.map(s => ({ ...s, responseBatchId: undefined }))), 2);
});
check("raw-message references, dates and details survive extraction", () => {
    const e = parse([item])[0];
    assert.deepEqual([...e.sourceMessageIds], ["m0", "m1"]);
    assert.equal(e.shiguang.dueAt, "2026-09-11");
    assert.equal(e.shiguang.story, item.story);
});
check("empty extraction is valid; malformed or invented references are rejected", () => {
    assert.equal(parse([]).length, 0);
    for (const bad of [{ ...item, sourceIds: ["s900"] }, { ...item, sourceIds: [] }, { ...item, dueAt: "2026-02-30" }, { ...item, existingId: "another-character-memory" }]) assert.throws(() => parse([bad]));
    assert.throws(() => parse([item], [], sources.map(s => ({ ...s, sourceApp: "moments" }))));
    assert.throws(() => domain.parseShiguangResult('"not an object"', sources, [], "c1", now));
    assert.throws(() => domain.parseShiguangResult('{"memories":[', sources, [], "c1", now));
});
check("updates retain identity and original source links", () => {
    const old = parse([item])[0];
    const changed = parse([{ ...item, existingId: old.id, status: "completed", sourceIds: ["s3", "s4"] }], [old])[0];
    assert.equal(changed.id, old.id);
    assert.equal(changed.shiguang.dueAt, undefined);
    assert.equal(changed.sourceMessageIds.length, 4);
    assert.equal(changed.shiguang.firstEventAt, old.shiguang.firstEventAt);
});
check("deleted and manually edited memories are not silently recreated", () => {
    const old = parse([item])[0];
    for (const flag of ["deletedAt", "userEdited"]) {
        const saved = { ...old, shiguang: { ...old.shiguang, [flag]: true } };
        assert.equal(parse([item], [saved]).length, 0);
    }
});
check("new progress can update a manually edited record without overwriting its facts", () => {
    const old = parse([item])[0];
    old.shiguang.userEdited = true;
    old.content = "用户手动整理的事实";
    const next = parse([{ ...item, existingId: old.id, summary: "试图改写", status: "completed", followup: "已经确认出发", sourceIds: ["s3"] }], [old])[0];
    assert.equal(next.content, old.content);
    assert.equal(next.shiguang.status, "completed");
    assert.match(next.shiguang.followup, /已经确认出发/);
    assert.equal(next.metadata.shiguangBaseUpdatedAt, old.updatedAt);
});
check("recall includes stable boundaries and timely promises within budget", () => {
    const e = parse([item])[0];
    const picked = domain.selectShiguangForPrompt([e], "今天看什么电影", 800, new Date(now));
    assert.match(picked[0].content, /提前商量/);
    assert.match(picked[0].content, /9月11日/);
    assert.ok(picked.reduce((n,e) => n + tokens.estimateTokens(e.content) + 4, 0) <= 800);
    assert.equal(domain.selectShiguangForPrompt([e], "海边", 0, new Date(now)).length, 0);
});
check("irrelevant experiences are omitted, relevant experiences recalled, deleted records excluded", () => {
    const e = parse([{ ...item, stableSummary: "", dueAt: "", status: "remembered" }])[0];
    assert.equal(domain.selectShiguangForPrompt([e], "午餐吃什么", 800, new Date(now)).length, 0);
    assert.equal(domain.selectShiguangForPrompt([e], "去海边", 800, new Date(now)).length, 1);
    assert.equal(domain.selectShiguangForPrompt([{ ...e, shiguang: { ...e.shiguang, deletedAt: now } }], "海边", 800, new Date(now)).length, 0);
});
check("oversized records do not block shorter relevant records", () => {
    const large = parse([{ ...item, stableSummary: "" }])[0];
    large.shiguang.recallSummary = "出行".repeat(5000);
    const small = { ...parse([{ ...item, title: "另一次出行", stableSummary: "" }])[0], id: "small" };
    const picked = domain.selectShiguangForPrompt([large, small], "出行", 150, new Date(now));
    assert.equal(picked.length, 1); assert.equal(picked[0].id, "small");
});

function harness(overrides = {}) {
    const state = { config: { ...memoryTypes.DEFAULT_MEMORY_CONFIG, shiguangRoundInterval: 5 }, calls: [], entries: [], watermark: undefined, ltWatermark: "long-term-unchanged", counter: 17, result: { content: JSON.stringify({ memories: [item] }) }, failSave: false, ...overrides };
    const timeline = Array.from({ length: 10 }, (_,i) => ({ ...sources[i % 4], id: `m${i}`, timestamp: `2026-09-05T20:${String(i).padStart(2,"0")}:00.000Z`, responseBatchId: i % 2 ? `batch${i}` : undefined }));
    const storage = {
        loadMemoryConfig: () => state.config,
        loadMemoryEntriesByType: async () => state.entries,
        getShiguangWatermark: () => state.watermark,
        setShiguangWatermark: (id, ts) => { state.watermark = ts; },
        saveMemoryBatch: async entries => { if (state.failSave) throw new Error("disk failure"); state.entries.push(...entries); },
        getEventCounter: () => state.counter,
    };
    const assembler = { loadNativeTimeline: (id, options) => timeline.filter(e => !options?.afterTimestamp || e.timestamp > options.afterTimestamp), filterTimelineByAllowedSources: (e, flags) => flags?.chat === false ? [] : e };
    const pipeline = load("lib/shiguang-summarizer.ts", {
        "./memory-storage": storage, "./short-term-assembler": assembler,
        "./settings-storage": { resolveAuxiliaryApiConfig: () => ({ id: "summary-api" }) },
        "./api-helpers": { simpleLLMCall: async (...args) => { state.calls.push(args); return state.result; } },
        "./shiguang-domain": domain,
    });
    return { state, pipeline, storage, assembler };
}
{
    const h = harness();
    await h.pipeline.maybeRunShiguang("c1", "林予");
    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.counter, 17); assert.equal(h.state.ltWatermark, "long-term-unchanged");
    await h.pipeline.maybeRunShiguang("c1", "林予");
    assert.equal(h.state.calls.length, 1);
    checks++; console.log("✓ independent frequency and watermark; processed messages do not repeat");
}
for (const kind of ["disabled", "auto-off", "below-threshold", "source-off", "long-term-off"]) {
    const h = harness();
    if (kind === "disabled") h.state.config.shiguangEnabled = false;
    if (kind === "auto-off") h.state.config.shiguangAutoEnabled = false;
    if (kind === "below-threshold") h.state.config.shiguangRoundInterval = 20;
    if (kind === "source-off") h.state.config.shortTermAllowedSources = { chat: false };
    if (kind === "long-term-off") h.state.config.autoSummarizeEnabled = false;
    await h.pipeline.maybeRunShiguang("c1", "林予");
    assert.equal(h.state.calls.length, kind === "long-term-off" ? 1 : 0);
    checks++; console.log("✓ frequency setting:", kind);
}
for (const kind of ["truncated", "invalid", "storage-failure", "empty-list"]) {
    const h = harness();
    if (kind === "truncated") h.state.result.wasTruncated = true;
    if (kind === "invalid") h.state.result.content = '{}';
    if (kind === "storage-failure") h.state.failSave = true;
    if (kind === "empty-list") h.state.result.content = '{"memories":[]}';
    const result = await h.pipeline.runShiguangPipeline("c1", "林予");
    assert.equal(result.success, kind === "empty-list");
    assert.equal(!!h.state.watermark, kind === "empty-list");
    checks++; console.log("✓ progress handling:", kind);
}
{
    const h = harness();
    await Promise.all([h.pipeline.runShiguangPipeline("c1", "林予"), h.pipeline.runShiguangPipeline("c1", "林予")]);
    assert.equal(h.state.calls.length, 1);
    checks++; console.log("✓ concurrent manual/automatic requests share a per-character lock");
}
for (const enabled of [true, false]) {
    const config = { ...memoryTypes.DEFAULT_MEMORY_CONFIG, autoSummarizeEnabled: enabled, maxLongTermEntries: 1, vectorRecallEnabled:false };
    const stored = [parse([item])[0], { id:"core",type:"core",createdAt:now }, { id:"old-long",type:"long_term",createdAt:"2026-01-01" }];
    let shiguangChecks=0, longCalls=0, counter=80, watermark, deleted=[];
    const pipeline = load("lib/memory-summarizer.ts", {
        "./memory-types": memoryTypes,
        "./shiguang-summarizer": { maybeRunShiguang:async()=>{shiguangChecks++;} },
        "./memory-storage": {
            loadMemoryConfig:()=>config,getEventCounter:()=>counter,getLastSummarizedTimestamp:()=>undefined,
            loadMemoryEntries:async()=>stored,saveMemoryBatch:async entries=>stored.push(...entries),
            setLastSummarizedTimestamp:(id,ts)=>{watermark=ts;},consumeEventCounter:(id,n)=>{counter-=n;},
            deleteMemoryEntries:async ids=>{deleted.push(...ids);},incrementCoreMemoryCounter:()=>undefined,
        },
        "./short-term-assembler": {loadNativeTimeline:()=>sources,filterTimelineByAllowedSources:e=>e,formatTimelineForSummarization:()=>({eventsText:"raw messages",earliest:sources[0].timestamp,latest:sources[3].timestamp})},
        "./settings-storage": {resolveAuxiliaryApiConfig:()=>({})},
        "./memory-embedding": {}, "./core-memory-builder":{maybeRunCoreMemoryPipeline:async()=>undefined},
        "./api-helpers":{simpleLLMCall:async()=>{longCalls++;counter+=2;return{content:"长期记忆总结"};}},
    });
    await pipeline.maybeRunSummarization("c1","林予");
    assert.equal(shiguangChecks,1);assert.equal(longCalls,enabled?1:0);
    if(enabled){assert.deepEqual(deleted,["old-long"]);assert.equal(counter,2);assert.equal(watermark,sources[3].timestamp);}
    checks++;console.log("✓ orchestration, independent enablement, in-flight counter preservation and long-term-only cleanup:", enabled);
}
{
    const config={...memoryTypes.DEFAULT_MEMORY_CONFIG};
    const e=parse([item])[0];
    const service=load("lib/memory-service.ts",{
        "./memory-storage":{loadMemoryEntriesByType:async(cid,type)=>cid==="c1"&&type==="shiguang"?[e]:[]},
        "./settings-storage":{},"./memory-embedding":{},"./token-counter":tokens,"./shiguang-domain":domain,
    });
    assert.equal((await service.retrieveMemoriesForPrompt("c1","海边",config)).length,1);
    assert.equal((await service.retrieveMemoriesForPrompt("c2","海边",config)).length,0);
    assert.equal((await service.retrieveMemoriesForPrompt("c1","海边",{...config,shiguangEnabled:false})).length,0);
    checks++;console.log("✓ actual memory service includes 拾光, respects disabling and isolates characters");
}
console.log(`Shiguang: ${checks} checks passed`);
