import * as api from "@/lib/shiguang-app-api";
import { saveMemoryEntry, loadMemoryEntriesByType, saveMemoryBatch, saveShiguangEdit, saveMemoryConfig } from "@/lib/memory-storage";
import { DEFAULT_MEMORY_CONFIG, type MemoryEntry } from "@/lib/memory-types";
import { selectShiguangForPrompt } from "@/lib/shiguang-domain";
import { loadCharacters } from "./characters";

declare global { interface Window { fixtureApi: unknown; appHtml: string; shiguangCheck?: { passed: boolean; checks?: number; error?: string } } }
const pause = () => new Promise(r => setTimeout(r, 40));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); checks++; };
let checks = 0;
const run = async () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    const created = "2026-09-01T02:37:00.000Z";
    const record: MemoryEntry = { id: "sg-app-one", characterId: "sg-app-c1", type: "shiguang", sourceApp: "chat", content: "宁妍画不下去时会循环听《月光》，沈烬言记得这个习惯，深夜分享给她。", createdAt: created, updatedAt: created, importance: .9, sourceMessageIds: ["source-user", "source-ai"], shiguang: {
        title: "月光与画画时的循环习惯", categories: ["共同经历", "喜好与边界"], reason: "宁妍深夜睡不着，想要陪伴。", story: "沈烬言分享《月光》，提到她上周三放了七遍。", details: [{ label: "音乐", value: "《月光》，版本未说明" }, { label: "当夜陪伴", value: "邀请她到书房看书，并表示天亮之前不关灯。" }], significance: "他留意到了画画习惯。", stableSummary: "画不下去时会重复播放音乐。", recallSummary: "不会再注入的隐藏文字", keywords: ["月光", "画画"], status: "remembered", followup: "", firstEventAt: created, lastEventAt: created,
    } };
    await saveMemoryEntry(record);
    await saveMemoryEntry({ ...record, id: "sg-app-delete", content: "用于删除验证的另一条独立记忆", shiguang: { ...record.shiguang!, title: "待删除测试记忆", stableSummary: "" } });
    await saveMemoryEntry({ ...record, id: "sg-app-other", characterId: "sg-app-c2", shiguang: { ...record.shiguang!, title: "另一个角色的故事" } });
    window.fixtureApi = { app: { getLaunchContext: async () => ({ characterId: "sg-app-c1" }) }, characters: { list: async () => loadCharacters() }, memory: {
        readShiguang: api.readShiguangApp, saveShiguang: api.saveShiguangApp, deleteShiguang: api.deleteShiguangApp,
        shiguangSources: api.shiguangAppSources, shiguangSettings: api.readShiguangSettings, configureShiguang: api.configureShiguangApp, organizeShiguang: api.organizeShiguangApp,
    } };
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:100%;height:100dvh;border:0;display:block";
    document.body.appendChild(iframe);
    iframe.srcdoc = window.appHtml.replace("<script>", "<script>window.AiPhone=parent.fixtureApi;</script><script>");
    const wait = async (test: () => unknown, description: string) => { for (let i = 0; i < 160; i++) { if (test()) return; await pause(); } throw new Error(description); };
    await wait(() => iframe.contentDocument?.querySelectorAll(".card").length === 2, "APP did not load legacy records");
    const doc = iframe.contentDocument!;
    const click = (selector: string) => (doc.querySelector(selector) as HTMLElement)?.click();
    const first = () => doc.querySelector('[data-id="sg-app-one"]')!;
    check(first().textContent?.includes("《月光》"), "legacy work title missing");
    check(!doc.body.textContent?.includes("不会再注入的隐藏文字"), "hidden summary leaked");
    check(!doc.body.textContent?.includes("另一个角色的故事"), "character separation failed");
    const before = (await loadMemoryEntriesByType("sg-app-c1", "shiguang")).find(e => e.id === record.id)!;
    check(before.shiguang!.promptSummary === undefined, "reading migrated storage destructively");
    (first().querySelector('[data-action="edit"]') as HTMLButtonElement).click();
    const form = doc.querySelector("#edit-form") as HTMLFormElement;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    field("promptSummary").value = "沈烬言深夜分享《月光》，记得宁妍画画时循环听了七遍。";
    field("recallMode").value = "relevant";
    form.requestSubmit();
    await wait(() => !(doc.querySelector("#editor") as HTMLDialogElement).open, "save did not finish");
    const edited = (await loadMemoryEntriesByType("sg-app-c1", "shiguang")).find(e => e.id === record.id)!;
    check(edited.shiguang?.userEdited, "edit was not persisted");
    const prompt = selectShiguangForPrompt([edited], "月光", 800, new Date());
    check(first().querySelector(".prompt-text")?.textContent === prompt[0].content, "displayed summary differs from actual injection");
    check(selectShiguangForPrompt([edited], "今天午餐", 800, new Date()).length === 0, "relevant policy ignored");
    // Actual IndexedDB transaction: stale edits and stale background results cannot overwrite the visible summary.
    let conflict = false;
    try { await saveShiguangEdit({ ...edited, content: "stale" }, before.updatedAt); } catch { conflict = true; }
    check(conflict, "stale edit was accepted");
    await saveMemoryBatch([{ ...record, content: "stale background", metadata: { shiguangBaseUpdatedAt: before.updatedAt } }]);
    check((await loadMemoryEntriesByType("sg-app-c1", "shiguang")).find(e => e.id === record.id)?.shiguang?.promptSummary === edited.shiguang?.promptSummary, "background overwrote user summary");
    (first().querySelector('[data-action="sources"]') as HTMLButtonElement).click();
    await wait(() => doc.querySelectorAll(".source").length === 2, "original messages not loaded");
    check(doc.querySelector("#sources")?.textContent?.includes("9月12日"), "source content missing");
    click("#close-sources");
    click('[data-id="sg-app-delete"] [data-action="delete"]');
    click("#confirm-delete");
    await wait(() => !(doc.querySelector("#delete-dialog") as HTMLDialogElement).open, "delete did not finish");
    const deleted = (await loadMemoryEntriesByType("sg-app-c1", "shiguang")).find(e => e.id === "sg-app-delete")!;
    check(deleted.shiguang?.deletedAt, "deletion was not a tombstone");
    check((await api.readShiguangApp({ characterId: "sg-app-c2" })).entries.length === 1, "other character changed");
    click('[data-tab="rules"]');
    const settings = doc.querySelector("#settings") as HTMLFormElement;
    (settings.elements.namedItem("tokenBudget") as HTMLInputElement).value = "1200";
    settings.requestSubmit();
    await wait(() => doc.querySelector("#settings-notice")?.textContent?.includes("已保存"), "settings not saved");
    check(api.readShiguangSettings().tokenBudget === 1200, "wrong persisted budget");
    click('[data-tab="memories"]');
    const search = doc.querySelector("#search") as HTMLInputElement;
    search.value = "不存在的内容"; search.dispatchEvent(new Event("input", { bubbles: true }));
    check(doc.querySelectorAll(".card").length === 0, "search filter failed");
    search.value = "月光"; search.dispatchEvent(new Event("input", { bubbles: true }));
    check(doc.querySelectorAll(".card").length === 1, "summary search failed");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    check(doc.documentElement.scrollWidth <= doc.documentElement.clientWidth + 1, "horizontal overflow");
    const oldHost = document.createElement("iframe"); oldHost.hidden = true; document.body.appendChild(oldHost);
    oldHost.srcdoc = window.appHtml;
    await wait(() => oldHost.contentDocument?.body.textContent?.includes("请先更新宿主"), "old host has no actionable warning");
    oldHost.remove();
    window.shiguangCheck = { passed: true, checks };
};
void run().catch(error => { window.shiguangCheck = { passed: false, error: String(error?.stack || error) }; });
