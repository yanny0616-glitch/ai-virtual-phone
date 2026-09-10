// Shared by the host and the single-file Gua Nian app. No IO or implicit clock.
export type PresenceSchedule = { time?: string; end?: string; title?: string; place?: string; mood?: string; cost?: number; busy?: boolean; steps?: {time?: string; what?: string}[] };
export type PresenceDay = { date?: string; wake?: string; bed?: string; doing?: string; location?: string; mood?: string; energy?: number; schedule?: PresenceSchedule[]; conds?: {startAt?: number; halfLifeMin?: number; intensity?: number; energyDelta?: number; mood?: string; cause?: string}[] };
export type PresenceSettings = {quietStart?: string; quietEnd?: string};
const busyPattern = /上课|课堂|听课|自习|复习|预习|写作业|做作业|赶作业|做题|考试|测验|开会|会议|值班|实习|训练|排练|实验|赶稿|写稿|编程|写代码|专注|集中精神|通勤|赶路|开车|面试|汇报|手术|门诊/;
const freePattern = /睡觉|睡眠|午睡|午休|补觉|休息|发呆|摸鱼|放松|吃饭|用餐|散步|刷视频|看番|打游戏|玩游戏|聊天|自由时间|准备睡|洗漱|刚醒|起床|看剧|逛/;
export function presenceBusy(it: PresenceSchedule): boolean {
  return typeof it.busy === 'boolean' ? it.busy : busyPattern.test(it.title || '') && !freePattern.test(it.title || '');
}
export function presenceDate(now: number): string {
  const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function time(value: string | undefined): string {
  const m = /(\d{1,2})\s*[:：点时.]\s*(\d{1,2})?/.exec(value || '');
  return m ? `${String(Math.min(23,+m[1])).padStart(2,'0')}:${String(Math.min(59,+(m[2]||0))).padStart(2,'0')}` : '';
}
function at(hm: string | undefined, now: number): number {
  if (!hm || !/^\d{2}:\d{2}$/.test(hm)) return now;
  const d = new Date(now); d.setHours(+hm.slice(0,2),+hm.slice(3),0,0); return d.getTime();
}
export function calculateGuanianPresence(day: PresenceDay | null, previous: PresenceDay | null, settings: PresenceSettings, now: number) {
  const data = day || previous;
  if (!data) return null;
  const d = new Date(now), hm = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const bed = time(data.bed) || settings.quietStart || '', wake = time(data.wake) || settings.quietEnd || '';
  const hasSleep = !!bed && !!wake && bed !== wake;
  if (!day && !hasSleep) return null;
  const asleep = hasSleep && (bed < wake ? hm >= bed && hm < wake : hm >= bed || hm < wake);
  const schedule = Array.isArray(data.schedule) ? data.schedule.filter(it=>it && it.time) : [];
  const done = [...schedule].reverse().find(it=>String(it.time)<=hm);
  const next = schedule.find(it=>String(it.time)>hm);
  const phase = asleep ? 'sleep' : !done ? hasSleep && bed < wake && hm < bed ? 'pre' : 'gap'
    : done.end && done.end > String(done.time) && hm >= done.end ? next ? 'gap' : 'pre' : 'on';
  const active = day && phase === 'on' ? done : undefined;
  const doing = !day ? asleep ? '睡觉' : hasSleep && bed < wake && hm < bed ? '还没睡，快上床了' : '刚起床，今天的安排还没定'
    : phase === 'sleep' ? '睡觉' : phase === 'on' ? done?.title || '' : phase === 'pre' ? '睡前自己待着，准备睡了' : done ? `歇着（刚忙完${done.title}）` : data.doing || '起床后的时间';
  let energy = data.energy != null ? +data.energy : 60;
  const h = d.getHours()+d.getMinutes()/60, hh = h < 5 ? h+24 : h;
  const conds = (Array.isArray(data.conds) ? data.conds : []).filter(c=>c && Number(c.startAt)<=now).map(c=>({c,w:Math.pow(0.5,Math.max(0,now-(Number(c.startAt)||0))/(Math.max(10,Number(c.halfLifeMin)||180)*60000))})).filter(x=>x.w>0.08).sort((a,b)=>b.w*(Number(b.c.intensity)||50)-a.w*(Number(a.c.intensity)||50));
  if (Array.isArray(data.schedule)) {
    for (const it of schedule) {
      if (h >= 5 && String(it.time)>hm) continue;
      const a = at(it.time,now), b = it.end ? at(it.end,now) : 0;
      const progress = b > a ? Math.max(0,Math.min(1,(now-a)/(b-a))) : 1;
      energy += Math.max(-15,Math.min(15,Math.round(Number(it.cost)||0)))*progress;
    }
    energy += Math.max(-12,conds.reduce((n,x)=>n+(Number(x.c.energyDelta)||0)*x.w,0));
    const wk = /^(\d{1,2}):(\d{2})$/.exec(data.wake || '');
    const wakeH = wk ? +wk[1]+ +wk[2]/60 : 7;
    energy -= Math.max(0,Math.min(hh,22)-wakeH)*1.2+Math.max(0,hh-22)*8;
  }
  const moods: {text:string;w:number}[] = [];
  if (conds[0]?.c.mood) moods.push({text:conds[0].c.mood,w:conds[0].w*(Number(conds[0].c.intensity)||50)/100});
  if (done?.mood) moods.push({text:done.mood,w:Math.pow(0.5,Math.max(0,now-at(done.time,now))/(90*60000))*0.6});
  moods.sort((a,b)=>b.w-a.w);
  const state = asleep ? 'sleep' : !day ? 'away' : active && presenceBusy(active) ? 'busy' : 'online';
  const steps = (Array.isArray(active?.steps)?active.steps:[]).filter(s=>s && s.time && s.time<=hm);
  return {
    at: now, state, label: !day && !asleep ? '今日状态待同步' : '', asleep, busy:state==='busy', doing,
    step:steps.length ? steps[steps.length-1].what || '' : '', place:!day || asleep ? '' : done?.place || data.location || '',
    mood:!day ? data.mood || '' : moods.find(m=>m.w>0.15)?.text || data.mood || '', energy:Math.max(0,Math.min(100,Math.round(energy))),
    next:!day ? asleep ? `${wake} 起床` : hasSleep && bed<wake && hm<bed ? `${bed} 睡觉` : ''
      : next ? `${next.time} ${next.title}` : phase==='pre' && hasSleep ? `${bed} 睡觉` : asleep && hasSleep ? `${wake} 起床` : '',
  };
}
export function guanianPresenceGate(day: PresenceDay | null, previous: PresenceDay | null, settings: PresenceSettings, now: number) {
  const data=day||previous;
  if(!data)return null;
  const bed=time(data.bed)||settings.quietStart||'',wake=time(data.wake)||settings.quietEnd||'';
  return {availabilityOnly:true,updatedAt:now,
    sleep:bed&&wake&&bed!==wake?{bed,wake}:undefined,
    busy:{date:presenceDate(now),windows:(Array.isArray(day?.schedule)?day.schedule:[]).filter(it=>it && presenceBusy(it) && it.time && it.end && it.end>it.time).map(it=>{
      const steps=(Array.isArray(it.steps)?it.steps:[]).filter(x=>x && x.time && x.time>=it.time! && x.time<it.end!).slice().sort((a,b)=>a.time!.localeCompare(b.time!));
      const breaks=steps.flatMap((x,i)=> /休息|茶歇|课间|中场休|散会|停车休息/.test(x.what||'') && !/不休息|没休息|没有休息|无休|取消休息/.test(x.what||'') ? [{from:x.time!,to:steps[i+1]?.time||it.end!}] : []);
      return {from:it.time!,to:it.end!,title:it.title||'',...(breaks.length?{breaks}:{})};
    })},
  };
}
