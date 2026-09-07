// 拾光 2.0 起在独立 APP 里存取自己的数据。宿主只留这一条只读接口，
// 供 APP 第一次打开时把 2.0 之前存在记忆库里的旧记录搬走。
import { loadCharacters } from "./character-storage";
import { loadMemoryEntriesByType } from "./memory-storage";

export async function readShiguangApp(record: Record<string, unknown>) {
    const id = typeof record.characterId === "string" ? record.characterId.trim() : "";
    if (!id || !loadCharacters().some(c => c.id === id)) throw new Error("角色不存在，请重新选择");
    const entries = (await loadMemoryEntriesByType(id, "shiguang")).filter(e => e.type === "shiguang" && e.shiguang);
    return { version: 2, entries };
}
