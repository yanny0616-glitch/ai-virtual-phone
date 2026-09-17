// 生成TA的一天：指令、解析归一。原先由 App 拼好寄到云端，现在后端自己拼（文案与 App generation.js 同源）。
// 日程表上已定的安排和固定作息仍在手机里，由 App 同步到后端（calendar 表）。

import { applyDueForks, forkLevel, normalizeForks } from "./vendor/forks.mjs";
import { addMin, normHM, pad2 } from "./life.ts";
import type { GuanianDay } from "./types.ts";

export const DEFAULT_DAY_PROMPT = [
  "以当前角色的人设、职业、近期记忆和最近聊天为依据，安排角色自己会过的一天：先定身体底子和情绪底色，再排日程。",
  "日程的主体是角色，不是用户，也不是替双方编写未来剧情。默认安排角色能独立决定和执行的工作、学习、兴趣、家务、吃饭和休息，保留自己的生活主线。",
  "涉及用户参与的共同活动，只有最新聊天中双方明确约好、用户明确同意且尚未取消时，才能列为共同日程。仅提过、角色想做、角色单方面要求、过去做过或关系亲密，都不等于用户已答应。",
  "标题、地点和备注都不能替用户安排未来行动、台词、感受或反应。即使约好一起吃饭，也不能预写用户一定赴约、吃完、嫌淡或如何回应；到点也不代表已经完成。",
  "可以写角色自己的打算和准备，例如自己吃午饭、准备饭菜、处理文件；没有共同约定时，不写陪用户吃饭、陪用户睡觉等需要用户配合才能成立的既定安排。",
  "已发生的互动可以作为背景影响角色状态，但不能自动延续成之后一整天的共同剧情。未来备注只写角色自己的准备和计划，不把尚未发生的细节写成事实。",
].join("\n");

/** 日程表上已定的安排（含固定作息展开的条目） */
export type FixedItem = { id?: string; startTime: string; endTime?: string; title: string; location?: string; lock?: string };
export type Routine = { wake?: string; bed?: string };
export type PastDay = { date: string; day: GuanianDay; characterId: string };

const CN_HOLIDAYS: Record<string, string> = { "01-01": "元旦", "02-14": "情人节", "03-08": "妇女节", "05-01": "劳动节", "05-04": "青年节", "06-01": "儿童节", "10-01": "国庆", "10-31": "万圣节", "11-11": "双十一", "12-24": "平安夜", "12-25": "圣诞", "12-31": "跨年夜" };

// 日历现实：身份决定默认作息，日历决定今天这套作息到底发不发生
export function calendarReality(date: string): { label: string; season: string } {
  const [y, m, day] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  const tags: string[] = [];
  if (wd === 0 || wd === 6) tags.push("周末");
  const h = CN_HOLIDAYS[pad2(m) + "-" + pad2(day)] || (m === 10 && day <= 7 ? "国庆假期" : "");
  if (h) tags.push(h);
  if (m === 7 || m === 8) tags.push("学校放暑假"); else if ((m === 1 && day >= 15) || (m === 2 && day <= 20)) tags.push("学校放寒假、春节前后");
  const season = m === 12 || m <= 2 ? "冬" : m <= 5 ? "春" : m <= 8 ? "夏" : "秋";
  return { label: `${y}-${pad2(m)}-${pad2(day)} 周` + "日一二三四五六"[wd] + (tags.length ? "（" + tags.join("、") + "）" : ""), season };
}

// 前几天的生活面：防止天天一样，也让昨天开了头的事今天有下文
export function recentDaysBrief(past: PastDay[], date: string): { lines: string[]; residue: string[] } {
  const rows = past.filter(r => r.date < date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  const lines = rows.map(r => {
    const hits = Array.isArray(r.day.forks) && r.day.forks.length
      ? (applyDueForks(r.day, "23:59", { seed: r.day.forkSeed || r.date + "|" + r.characterId }).day.forks as { state?: string; what?: string }[]).filter(f => f && f.state === "hit")
      : [];
    return "- " + r.date + (r.day.mood ? " 心情「" + r.day.mood + "」" : "")
      + (r.day.sleep ? " 睡眠「" + r.day.sleep + "」" : "") + (Number.isFinite(Number(r.day.energy)) ? " 起床精力 " + Number(r.day.energy) : "") + "："
      + ((r.day.schedule || []).map(it => it.title).filter(Boolean).join("、") || "没生成日程")
      + (r.day.bed ? "（" + r.day.bed + " 睡）" : "") + (hits.length ? "；那天碰上的事：" + hits.map(f => f.what).join("；") : "");
  });
  const [y, m, d] = date.split("-").map(Number);
  const yd = new Date(Date.UTC(y, m - 1, d - 1));
  const yKey = `${yd.getUTCFullYear()}-${pad2(yd.getUTCMonth() + 1)}-${pad2(yd.getUTCDate())}`;
  const yRow = rows.find(r => r.date === yKey);
  const residue: string[] = [];
  if (yRow?.day.bed && yRow.day.bed < "06:00") residue.push("昨晚 " + yRow.day.bed + " 才睡");
  if (yRow && Array.isArray(yRow.day.conds)) {
    const c = yRow.day.conds.slice().sort((a, b) => (+(b.startAt || 0)) - (+(a.startAt || 0)))[0];
    if (c && c.mood) residue.push("昨天最后一次聊完的情绪「" + c.mood + "」（" + (c.cause || "聊天") + "）");
  }
  return { lines, residue };
}

function forkGuide(nowHM: string, level: unknown): string {
  const n = ["0 到 1", "1 到 2", "2 到 3"][forkLevel(level)];
  return "forks 是今天可能出的岔子：从 schedule 里挑 " + n + " 件 " + nowHM + " 以后才开始的事，各埋一个。岔子要从这件事本身长出来（面试→来的是老同学，出门→下雨没带伞，开店→熟客抱来一只猫），好事坏事都要有，别全是倒霉事，也别狗血。"
    + "p 是真实的可能性：平常的小意外 20 到 40，少见的 10 左右。发生后只改写它之后的安排：add 插进一件因此多出来的事，move 把后面的事往后挪，drop 取消后面的事，用不上就给 null 或空数组。"
    + "tell 看TA的性子和这件事的分量：想分享、憋不住的写忍不住；觉得不值一提、等聊到再说的写聊到才说；丢脸、难过、怕人担心的写憋着。岔子TA事先并不知道，别提前写进 schedule 的 note、mood 或其他字段。";
}

export function buildDayInstruction(opts: {
  date: string; nowHM: string; dayPrompt?: string; forkLevel?: unknown;
  past: { lines: string[]; residue: string[] }; existing: FixedItem[]; threads: string[]; routine: Routine;
}): string {
  const cal = calendarReality(opts.date);
  let inst = [
    "【后台系统任务，不是聊天：不要以角色口吻说话，不要解释，只输出 JSON】",
    String(opts.dayPrompt || "").trim() || DEFAULT_DAY_PROMPT,
    "今天：" + cal.label + "，" + cal.season + "季，现在时刻 " + opts.nowHM + "。身份决定默认作息（学生上课、上班族通勤、店主开门），日历决定这套作息今天到底发不发生：周末、假期不上班不上课，除非人设是轮班、服务业、演艺这类越放假越忙的；季节要影响户外活动和穿着。夜猫子可以很晚睡，上早班的就得早起。",
    opts.past.lines.length ? "前几天TA过的日子（别重复同一套骨架；昨天开了头的事今天要有下文，做完的事要有余韵；跨好几天的事——项目、备考、排练、等结果——按筹备、进行、收尾、余波的顺序往下走，让这几天连成线）：\n" + opts.past.lines.join("\n") : null,
    opts.past.lines.length ? "睡眠和精力会恢复：前几天没睡好不会自动延续到今天。昨晚没有新的原因（聊到深夜、新的烦心事、生病、通宵）时，今天的睡眠要比前一天好转，起床精力逐天回到正常的 70 到 90；已经连着几天偏低的，今天要明显回升。偶尔没睡好照样可以写，但要有昨晚自己的原因。" : null,
    opts.past.residue.length ? "昨天留下的余波：" + opts.past.residue.join("；") + "。睡得晚、聊得不痛快、约了事，都可以轻微影响今天的睡眠、精力、胃口和心情；但不要为了戏剧性硬让今天出事，可以毫无影响。" : null,
    opts.threads.length ? "惦记账本（已了结项仅供判重，不再安排；未了结事项：约好在今天的必须落进 schedule；到日子的要影响今天的心情和安排；只是话头的不用硬排）：\n" + opts.threads.join("\n") : null,
    "最近聊天中角色明确要做的事、未取消的承诺，以及双方已明确说定的共同安排，应落进 schedule；仅提过但没说定的共同活动不要当作约定。",
    "输出严格 JSON，第一个字符必须是 {，不要代码块标记，字段名必须一字不差用下面这些：",
    '{"sleep":"昨晚睡得怎样（一句具体的：踏实/浅、半夜醒/失眠/一直做梦/赖床）","mood":"今天刚醒时的情绪底色（8字内，具体，不要「心情不错」这种空话）","moodEmoji":"一个最贴切的emoji","energy":今天刚醒来时的精力基线0到100的整数,"body":[{"label":"此刻身上的小状况（8字内：饿、胃口差、头闷、腰酸、犯困、嗓子哑之类）","mood":"它带来的情绪（4字内）","energy":对精力的影响-8到8的整数,"hours":大概几小时淡一半（1到12）}],"doing":"此刻正在做的事","location":"此刻所在的地点","wake":"今天起床的时刻HH:MM","bed":"今晚上床睡觉的时刻HH:MM（可以过零点，如 00:30）","schedule":[{"time":"HH:MM","end":"这件事大概结束的时刻HH:MM","title":"日程标题（8字内）","place":"做这件事时人在哪（6字内：家里书房/公司/地铁上/医院）","note":"一句具体的细节","mood":"做完这件事之后TA的情绪（8字内）","cost":这件事做完对精力的影响-15到15的整数,"busy":做这件事时顾不上看手机吗（上课/开会/开车/考试/训练/排练之类为true，吃饭/通勤/闲着/看剧为false）}],"forks":[{"at":"埋在哪条日程上（抄那条的 time）","time":"那件事开始后岔子冒出来的时刻HH:MM","what":"发生了什么（30字内，具体）","label":"发生后TA身上带着的状态（6字内：淋了雨/被夸了/捡了只猫）","p":发生的可能性10到60的整数,"mood":"发生后的情绪（8字内）","energy":对精力的影响-10到10的整数,"tell":"TA会不会跟用户说：忍不住/聊到才说/憋着 选一","add":{"time":"HH:MM","end":"HH:MM","title":"因此多出来的事（8字内）","place":"在哪（6字内）","busy":true或false}或null,"move":[{"time":"被挤走的那条原来的time","newTime":"挪到的HH:MM"}],"drop":["因此不做了的那条原来的time"]}]}',
    "body 是今天真实带在身上的状况，多数日子是空数组，最多两条；有近期经历依据才写，不要每天编造胃痛、头闷。轻微不适扣 1 到 3，明显不适扣 4 到 8；情绪低落本身不扣身体精力。",
    "情绪写法：用可感的状态词（迷糊、清爽、松弛、专注、疲惫、烦躁、雀跃、低落、发紧、放空、粘人）再带一点原因或身体感受，例如「开完会后脑子发紧」；一天里要有起伏，别每条都差不多；情绪要和 cost 对得上，耗神的事之后不该是「轻松」，回血的事之后不该是「疲惫」；底色 mood 要能从 sleep 和昨天的余波推出来。",
    "energy 是身体的电量，和情绪底色是两回事：心情差但睡饱了 energy 照样高，心情好但熬了夜 energy 照样低。不要把「今天不开心」「性格沉闷」翻译成「精力低」。",
    "energy 是扣除 body 之前的起床基线，正常睡眠通常 70 到 90；睡眠不足可为 50 到 69，低于 50 需要明确的生病、通宵或严重睡眠不足依据。不能因为角色心情低落就给低精力，也不要把同一身体不适同时扣进基线和 body。",
    "cost 是整段活动做完的总变化，负数=消耗，正数=恢复，不是每小时扣费。普通通勤/事务扣 1 到 3，普通会议/工作扣 3 到 8，连续数小时高强度活动才扣 9 到 15；吃饭/散步恢复 2 到 5，午睡/充分休息恢复 5 到 12，平淡的事给 0。自然清醒消耗由 APP 另算，不要重复扣；日程必须包含真实的吃饭和休息。普通一天日程净消耗尽量不超过 30，避免正常生活还没到中午就接近 0。",
    "schedule 给 5 到 9 条，从起床后第一件事到睡前最后一件事；有主线也有琐碎，时间不均匀；不用把每个小时填满，事与事之间可以留空档（空档里TA就是自己待着）；有的日子轻（3、4 条），有的日子满；最后一件事结束到 bed 之间是TA自己的睡前时间；「睡觉」本身不要写成一条日程。",
    forkGuide(opts.nowHM, opts.forkLevel),
  ].filter(Boolean).join("\n");
  const fix = opts.routine;
  if (fix.wake || fix.bed) inst += "\nTA的作息是定好的：" + [fix.wake ? fix.wake + " 起床" : "", fix.bed ? fix.bed + " 上床" : ""].filter(Boolean).join("，") + "，wake 和 bed 照抄。";
  if (opts.existing.length) {
    inst += "\nTA的日程表上今天已经定了这些安排（必须原样出现在 schedule 里，时间与标题不要改动，带 busy 的照抄 busy，围绕它们补全其余的一天）：\n"
      + JSON.stringify(opts.existing.map(it => Object.assign({ time: it.startTime, title: it.title, note: it.location || "" }, it.lock ? { busy: it.lock === "busy" } : {})));
  }
  return inst;
}

function pickField(o: any, keys: string[]): any {
  for (const k of keys) if (o && o[k] != null && String(o[k]).trim() !== "") return o[k];
  return "";
}
const isTrue = (v: unknown): boolean => v === true || /^(true|是|1)$/i.test(String(v || "").trim());

export type DayFull = Required<Pick<GuanianDay, "wake" | "bed" | "mood" | "moodEmoji" | "energy" | "doing" | "location" | "sleep" | "schedule" | "conds" | "forks">>;

// 把模型返回的 JSON 归一成当天记录
export function parseDayResult(d: any, existing: FixedItem[], settings: { quietStart?: string; quietEnd?: string; forkLevel?: unknown }, nowMs: number): DayFull {
  const schedRaw = pickField(d, ["schedule", "日程", "日程表"]);
  if (!Array.isArray(schedRaw)) throw new Error("日程缺失（模型返回的字段：" + Object.keys(d || {}).slice(0, 10).join("/") + "）");
  const sched = schedRaw.slice(0, 10).map((it: any) => ({
    time: normHM(pickField(it, ["time", "时间", "at"])),
    end: normHM(pickField(it, ["end", "endTime", "结束", "到"])),
    title: String(pickField(it, ["title", "标题", "事项", "name"]) || ""),
    place: String(pickField(it, ["place", "地点", "位置", "在哪"]) || "").slice(0, 16),
    note: String(pickField(it, ["note", "备注", "细节", "desc"]) || ""),
    mood: String(pickField(it, ["mood", "情绪", "心情"]) || "").slice(0, 24),
    cost: Math.max(-15, Math.min(15, Math.round(+pickField(it, ["cost", "精力影响", "消耗"]) || 0))),
    busy: pickField(it, ["busy", "顾不上", "忙"]) === "" ? undefined : isTrue(pickField(it, ["busy", "顾不上", "忙"])),
  }));
  for (const it of existing) { // 模型漏掉的已定安排补回来；定死了忙闲的以日程表为准
    const hit = sched.find((x: { time: string }) => x.time === it.startTime);
    if (!hit) sched.push({ time: it.startTime, end: "", title: it.title, place: it.location || "", note: it.location || "日程表上的安排", mood: "", cost: 0, busy: it.lock ? it.lock === "busy" : undefined });
    else if (it.lock) hit.busy = it.lock === "busy";
  }
  sched.sort((a: { time: string }, b: { time: string }) => String(a.time).localeCompare(String(b.time)));
  for (const it of sched) if (it.end && it.end <= it.time) it.end = "";
  const last = sched[sched.length - 1];
  const wake = normHM(pickField(d, ["wake", "起床", "wakeUp"])) || (sched[0] && sched[0].time) || String(settings.quietEnd || "");
  const bodyRaw = pickField(d, ["body", "身体", "状况"]);
  const conds = (Array.isArray(bodyRaw) ? bodyRaw : []).slice(0, 2)
    .filter((b: any) => b && String(b.label || "").trim())
    .map((b: any) => ({
      mood: String(b.mood || b.label).trim().slice(0, 24),
      cause: String(b.label).trim().slice(0, 20),
      energyDelta: Math.max(-8, Math.min(8, Math.round(+b.energy || 0))),
      intensity: 60,
      halfLifeMin: Math.max(1, Math.min(12, Math.round(+b.hours || 4))) * 60,
      startAt: nowMs,
    }));
  const bed = normHM(pickField(d, ["bed", "睡觉", "bedtime"])) || (last ? addMin(last.end || last.time, last.end ? 30 : 90) : String(settings.quietStart || ""));
  return {
    wake, bed,
    mood: String(pickField(d, ["mood", "心情", "情绪"]) || ""),
    moodEmoji: String(pickField(d, ["moodEmoji", "emoji", "表情"]) || "🌙").slice(0, 4),
    energy: Math.max(0, Math.min(100, +pickField(d, ["energy", "精力", "体力"]) || 60)),
    doing: String(pickField(d, ["doing", "正在做", "当前"]) || ""),
    location: String(pickField(d, ["location", "位置", "地点"]) || ""),
    sleep: String(pickField(d, ["sleep", "睡眠", "昨晚"]) || "").slice(0, 40),
    schedule: sched,
    conds,
    forks: normalizeForks(pickField(d, ["forks", "变数", "岔子"]), sched, settings.forkLevel),
  };
}
