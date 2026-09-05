import { createRoot } from "react-dom/client";
import { ShiguangPanel } from "@/components/memory/shiguang-panel";
import { deleteCharacterMemories, saveMemoryBatch, saveMemoryEntry, loadMemoryEntriesByType, setShiguangWatermark, getShiguangWatermark, setLastSummarizedTimestamp, getLastSummarizedTimestamp } from "@/lib/memory-storage";
import type { MemoryEntry } from "@/lib/memory-types";

declare global { interface Window { shiguangCheck?: { passed: boolean; checks?: number; error?: string } } }
const cid = "shiguang-browser-test";
let checks = 0;
const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); checks++; };
const wait = () => new Promise(r => setTimeout(r, 60));
async function until(predicate: () => boolean) { for(let i=0;i<80;i++){if(predicate())return;await wait();}throw new Error("UI update timed out"); }
const button = (text: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(text));
    if (!found) throw new Error(`Missing button: ${text}; visible buttons: ${[...document.querySelectorAll("button")].map(b=>b.textContent).join(" | ")}`);
    return found;
};
const input = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(el,value);
    el.dispatchEvent(new Event("input",{bubbles:true}));
};
async function run() {
    await deleteCharacterMemories(cid);
    const now = new Date().toISOString();
    const record: MemoryEntry = { id: "sg-browser-one", characterId: cid, type: "shiguang", sourceApp: "chat", content: "约好9月12日去海边，林予会提前确认安排。", createdAt: now, updatedAt: now, importance: .9, sourceMessageIds: ["source-user","source-ai"], shiguang: {
        title: "出发前，给你一个准信", categories: ["约定与承诺"], reason: "临时变动会让你不安，希望提前知道。", story: "林予答应前一天确认出发时间。", details: [{ label: "确认日期", value: "9月11日晚上" }], significance: "提前告知变化，并一起商量。", stableSummary: "提前商量计划变动", recallSummary: "9月12日去海边", keywords: ["海边"], dueAt: "2026-09-11", status: "pending", followup: "等待确认", firstEventAt: now, lastEventAt: now,
    } };
    await saveMemoryBatch([record]);
    assert((await loadMemoryEntriesByType(cid,"shiguang")).length===1,"IndexedDB persistence");
    const locked = { ...record, shiguang: { ...record.shiguang!, userEdited:true } };
    await saveMemoryEntry(locked);
    await saveMemoryBatch([{ ...record, content:"should not overwrite" }]);
    assert((await loadMemoryEntriesByType(cid,"shiguang"))[0].content===record.content,"in-flight generation respects user edit");
    setLastSummarizedTimestamp(cid,"2026-01-01"); setShiguangWatermark(cid,"2026-09-05");setShiguangWatermark(cid,"2026-08-01");
    assert(getShiguangWatermark(cid)==="2026-09-05" && getLastSummarizedTimestamp(cid)==="2026-01-01","separate monotonic progress");
    await saveMemoryEntry(record);
    const others = Array.from({length:24},(_,i)=>({ ...record, id:`extra-${i}`, content:`第${i+1}次听雨的记忆`, shiguang:{...record.shiguang!, title:`那晚听雨 ${i+1}`, categories:["共同经历" as const]} }));
    await saveMemoryBatch(others);
    createRoot(document.getElementById("root")!).render(<ShiguangPanel characterId={cid} characterName="林予" userName="你"/>);
    await until(()=>document.querySelectorAll(".sg-record").length===20);
    assert([...document.querySelectorAll<HTMLDetailsElement>(".sg-note")].every(e=>!e.open),"default collapsed");
    assert(!document.body.textContent!.includes("给模型看的内容"),"no prompt text in card");
    button("下一页").click(); await until(()=>document.querySelectorAll(".sg-record").length===5);
    assert(true,"pagination");
    (document.querySelector(".sg-filter-btn") as HTMLButtonElement).click();await wait();
    const category=[...document.querySelectorAll<HTMLLabelElement>(".sg-chip")].find(l=>l.textContent==="约定与承诺")!.querySelector("input")!;
    category.click();await until(()=>document.querySelectorAll(".sg-record").length===1);
    assert(true,"category filter");
    const search=document.querySelector<HTMLInputElement>("input[type=search]")!;
    input(search,"不存在的文字");await until(()=>document.querySelectorAll(".sg-record").length===0);assert(true,"search empty result");
    input(search,"海边");await until(()=>document.querySelectorAll(".sg-record").length===1);
    (document.querySelector(".sg-summary") as HTMLElement).click();await wait();
    button("回看原消息").click();await until(()=>document.querySelectorAll(".sg-msg").length===2);
    const sourceBox=document.querySelector(".sg-source")!.getBoundingClientRect();
    for(const msg of document.querySelectorAll(".sg-msg")){
        const bubble=msg.querySelector("p")!.getBoundingClientRect();
        const side=msg.classList.contains("sg-user")?"right":"left";
        assert(bubble.width<=sourceBox.width*.85+1,"bubble width");
        assert(Math.abs(bubble[side]-sourceBox[side])<1,"bubble edge alignment");
    }
    button("编辑与后续").click();await wait();
    const title = document.querySelector<HTMLTextAreaElement>(".sg-update textarea")!;
    input(title,"出发前再次确认");
    (document.querySelector(".sg-update") as HTMLFormElement).requestSubmit();
    await until(()=>document.querySelector(".sg-note h2")?.textContent==="出发前再次确认");
    assert((await loadMemoryEntriesByType(cid,"shiguang")).some(e=>e.shiguang?.title==="出发前再次确认"),"edited title persisted");
    button("编辑与后续").click();await wait();button("删除这条记忆").click();await wait();
    button("删除记忆").click();await until(()=>document.querySelectorAll(".sg-record").length===0);
    assert(!!(await loadMemoryEntriesByType(cid,"shiguang")).find(e=>e.id===record.id)?.shiguang?.deletedAt,"deleted record excluded with duplicate tombstone");
    await saveMemoryEntry(record);window.dispatchEvent(new CustomEvent("shiguang-updated"));
    await until(()=>document.querySelectorAll(".sg-record").length===1);
    (document.querySelector(".sg-summary") as HTMLElement).click();await wait();
    button("回看原消息").click();await until(()=>document.querySelectorAll(".sg-msg").length===2);
    (document.querySelector(".sg-filter-btn") as HTMLButtonElement).click();await wait();
    assert(document.documentElement.scrollWidth<=window.innerWidth+1,"mobile layout has no horizontal overflow");
    assert(getComputedStyle(document.querySelector(".sg-note h2")!).fontSize==="17px","approved title size");
    window.shiguangCheck={passed:true,checks};
}
run().catch(error=>{window.shiguangCheck={passed:false,error:String(error)};});
