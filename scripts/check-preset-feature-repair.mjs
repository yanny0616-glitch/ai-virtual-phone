import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// 运行真实领域模块及依赖，不加载浏览器数据库，也不修改用户预设。
const root = fileURLToPath(new URL("../", import.meta.url));
const modules = new Map();
function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
        exports,
        require: specifier => {
            assert.ok(specifier.startsWith("."), `unexpected dependency: ${specifier}`);
            return load(resolve(dirname(file), specifier + ".ts"));
        },
    }, { filename: file });
    return exports;
}
const { completePresetFeatures } = load(resolve(root, "lib/preset-feature-repair.ts"));
const { createBuiltinPreset, PATCHABLE_PROMPT_IDS } = load(resolve(root, "lib/builtin-preset.ts"));
const plain = value => JSON.parse(JSON.stringify(value));
const p = (identifier, extra = {}) => ({ identifier, name: identifier, content: "用户正文", role: "system", enabled: true, injection_depth: 0, ...extra });
const base = extra => ({ ...createBuiltinPreset(), id: "mine", builtIn: false, name: "旧的自创预设", prompts: [], prompt_order: [], ...extra });
let checks = 0;
function test(name, run) { run(); checks++; console.log(`PASS ${name}`); }

test("旧预设保留正文、参数、自定义排序；只补清单入口并追加到尾部", () => {
    const old = base({ temperature: 0.3, prompts: [p("a"), p("shortTermMemory", { marker: true }), p("b")], prompt_order: [{ identifier: "b", enabled: false }, { identifier: "a", enabled: true }, { identifier: "shortTermMemory", enabled: true }] });
    const snapshot = plain(old);
    const result = completePresetFeatures(old);
    assert.deepEqual(plain(old), snapshot, "输入不能被修改");
    assert.deepEqual(plain(result.added.map(v => v.identifier)), plain(PATCHABLE_PROMPT_IDS));
    assert.deepEqual(plain(result.preset.prompts.slice(0, 3)), snapshot.prompts);
    assert.deepEqual(plain(result.preset.prompt_order.slice(0, 3)), snapshot.prompt_order);
    assert.equal(result.preset.temperature, 0.3);
    assert.equal(result.preset.id, "mine");
});
test("空白新建预设可补齐，重复点击无变化", () => {
    const result = completePresetFeatures(base());
    assert.equal(result.added.length, PATCHABLE_PROMPT_IDS.length);
    const again = completePresetFeatures(result.preset);
    assert.equal(again.added.length, 0);
    assert.equal(again.preset, result.preset);
});
test("内置预设已有入口时无变化", () => {
    const old = createBuiltinPreset();
    assert.equal(completePresetFeatures(old).preset, old);
});
test("无顺序表的导入预设保留原排列及禁用状态", () => {
    const result = completePresetFeatures(base({ prompts: [p("b", { enabled: false }), p("a")], prompt_order: undefined }));
    assert.deepEqual(plain(result.preset.prompt_order.slice(0, 2)), [{ identifier: "b", enabled: false }, { identifier: "a", enabled: true }]);
});
test("原来未列入顺序表的条目仍在新入口之前", () => {
    const result = completePresetFeatures(base({ prompts: [p("a"), p("orphan")], prompt_order: [{ identifier: "a", enabled: true }] }));
    assert.deepEqual(plain(result.preset.prompt_order.slice(0, 2).map(v => v.identifier)), ["a", "orphan"]);
});
test("同标识自定义正文和关闭状态不被替换", () => {
    const existing = p("custom_app_context", { content: "我的修改", enabled: false });
    const result = completePresetFeatures(base({ prompts: [existing], prompt_order: [{ identifier: existing.identifier, enabled: false }] }));
    assert.equal(result.preset.prompts[0], existing);
    assert.deepEqual(plain(result.added.map(v => v.identifier)), ["custom_app_context_group"]);
    assert.equal(result.preset.prompt_order[0].enabled, false);
});
test("只有关闭的顺序记录时补正文但不重开、不重复顺序", () => {
    const result = completePresetFeatures(base({ prompt_order: [{ identifier: "custom_app_context", enabled: false }] }));
    assert.equal(result.preset.prompt_order.filter(v => v.identifier === "custom_app_context").length, 1);
    assert.equal(result.preset.prompt_order[0].enabled, false);
});
test("用户改名的单聊宏保留，包括限制为文字聊天和关闭的情况", () => {
    const alias = p("my_context", { content: "状态：{{ customAppContext }}", tags: ["chat", "text"], enabled: false });
    const result = completePresetFeatures(base({ prompts: [alias] }));
    assert.deepEqual(plain(result.added.map(v => v.identifier)), ["custom_app_context_group"]);
    assert.equal(result.preset.prompts[0], alias);
});
test("通用宏覆盖两个场景，不重复添加", () => {
    assert.equal(completePresetFeatures(base({ prompts: [p("alias", { content: "{{customAppContext}}" })] })).added.length, 0);
});
test("旧版 featureTag 群聊宏只覆盖群聊", () => {
    const result = completePresetFeatures(base({ prompts: [p("alias", { content: "{{customAppContext}}", featureTag: "group_chat" })] }));
    assert.deepEqual(plain(result.added.map(v => v.identifier)), ["custom_app_context"]);
});
test("其他场景的同名宏和不解析正文的 marker 不误判为已有入口", () => {
    for (const extra of [{ tags: ["story"] }, { marker: true }]) {
        assert.equal(completePresetFeatures(base({ prompts: [p("alias", { content: "{{customAppContext}}", ...extra })] })).added.length, PATCHABLE_PROMPT_IDS.length);
    }
});
console.log(`预设功能补齐：${checks} 项通过`);
