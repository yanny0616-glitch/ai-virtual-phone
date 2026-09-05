  /* ================= 数据 ================= */
  async function upsert(coll, match, data) {
    const rows = await AiPhone.db.list(coll, { limit: 100 });
    const hit = (rows || []).find(match);
    if (hit) return AiPhone.db.update(coll, hit.id, data);
    return AiPhone.db.create(coll, data);
  }

  // 所有可调参数的默认值；旧版本存的 settings 缺哪个补哪个
  const SET_DEF = {
    quietStart: "23:30", quietEnd: "08:00",
    userSleepOn: false,  // 用户可选睡眠窗：仅暂停回音统计的等待计时，默认不启用
    userSleepStart: "23:30", userSleepEnd: "08:00",
    autoGen: false,      // 每天到点自动生成TA的一天（要挂念开着；错过了下次打开时补）
    autoGenAt: "07:30",
    cloudGen: false,     // 到点由云端生成TA的一天并编排（浏览器关着也行；需要云连接 + 自动生成）
    genTpls: {},         // 每个角色云端生成借用的提示词模板 { cid: { daily, impulse, at } }
    sentinels: {},       // 每个角色的哨兵预约 { cid: { wakeId, armed } }
    characterIds: [],    // 挂念的人（可以多位）
    deviceId: "",        // 本机随机 id：电脑和手机同时开着时，云端计划行靠它认「今天谁负责」
    deviceName: "",      // 本机叫什么（按 UA 猜，只给自己看）
    apiDailyCap: 40,     // 本机 + 云端合计一天最多调多少次模型（0=不限）
    tokenDailyCap: 0,    // 本机 + 云端合计一天最多多少 token（0=不限）
    apiUse: null,        // 今天本机已调用 { date, n }（宿主统计落后时的兜底计数）
    quota: 3,            // 每天最多主动几次
    minGapMin: 60,       // 相邻两次起念最小间隔（分钟，0=不限制）
    maxUnanswered: 2,    // 未回应降速：TA连续 N 轮主动未被回后今天不再主动（0=关闭）
    bias: 0,             // 主动倾向 -2很克制 … 2黏人
    anchorSleep: true,   // 睡前锚点
    anchorMorning: false,// 早安锚点
    chatCandidates: true,// 复核时允许因聊天临时起念
    recheckMin: 15,      // 动态复核间隔（分钟，0=关闭；打开 app 也检查，但仍遵守上次尝试的间隔）
    judgeLines: 24,      // 编排/复核/云端裁决喂给模型的最近几句聊天
    moodGate: true,      // 精力低/心情差时更克制
    injectChat: true,    // 把TA此刻的状态注入聊天提示词（需 chat.context 权限）
    chatEditsDay: true,  // 复核时允许按聊天内容改今天的日程（只动还没到的）
    cloudUrl: "",        // 个人云（Supabase）项目地址，选填
    cloudKey: "",        // 个人云 Secret / service_role key，只存本机应用数据
    cloudRecheck: true,  // 浏览器关着时也让云端复核（需要云连接）
    // 云端门禁：这几道全过了云端才真的发一次裁决调用，拦下来的不花钱也不占额度
    gateDailyCap: 8,     // 每天最多判几次
    gateGapMin: 25,      // 两次判之间最小间隔（分钟）
    gateHorizonMin: 240, // 最近的待发时刻比这更远就先不判（分钟，0=不限）
    gateFreshMin: 10,    // 你刚说完话先等这么久再判（分钟，0=不等）
    gateMinMsgs: 1,      // 上次判完你至少说这么多句才判
    selfImpulseCap: 6,   // 没新聊天时每天最多几次自发起念（云端复核；0=关）
    impulseMode: 1,      // 0=早上一把定完  1=随用随判：编排不排念头，白天云端随时起
    selfSilenceMin: 120, // 多久没联系算「安静太久」（自发起念的由头之一）
    missDays: 3,         // 断了几天算「想念」（0 关）。每段断联云端只掷一次骰子，掷过的键记在 missState 里跨天带着
    echoOn: true,        // 昨天的余韵：每天掷一次，想起昨天聊过的一件小事
    missState: {},       // { cid: 用户最后一句的时间戳 }，云端掷过想念骰子的那段断联
    fbState: {},         // { cid: { kind: [发过, 回了] } }，各类由头的回音账，云端记、本机存，跨天带着
    // 发送前复核：到点真发之前再综合判一次，不合时宜度超过 presendMax 就不发
    presendMax: 70,        // 不合时宜度阈值（%），100 = 从不拦
    presendTalkingMin: 15, // 你最后一句话在这么久以内算「正聊着」（分钟）
    presendGapMin: 60,     // 离TA上一条主动这么久以内算「太密」（分钟）
    // 忙与睡：到点了TA顾不上时怎么办（云端到点判；本地「仅在线」路径不管）
    busyHold: false,       // 忙着（上课/开会/开车…）就押到忙完再发
    busyBufferMin: 10,     // 忙完 / 醒来后再等几分钟
    busyMaxHoldMin: 180,   // 从原时刻起最多押多久，超过就作罢
    sleepMode: 0,          // 睡着时：0 不发 · 1 押到起床后 · 2 按概率醒来发
    sleepWakeProb: 18,     // 概率醒来的百分比
    // 你发消息时也照这套来（宿主判，挂念关着也管用）：睡着押到醒来、忙着偷空再回
    replyGate: true,
    busyPeekMin: 3,        // 忙着时偷空看一眼手机大约要等几分钟（0 = 不等）
    // 惦记账本：聊天里冒出来的没聊完的话头、约好的事、重要的日子，跨天记着；起念、生成明天、注入聊天、到点发消息都看它
    threadsOn: true,
    threadDays: 3,         // 话头几天没再提就淡掉（约定按时间、日子按日期各自作废）
    showAdv: false,        // 设置面板是否展开高级组
    momentsOn: true,       // 替TA发朋友圈：生活轮掷骰子 + 分享型念头改走朋友圈（宿主要有 moments.post 接口）
    momentsWeekly: 3,      // 一周最多几条（发圈的唯一一套数：装了挂念，「朋友圈节奏」插件让位读这份）
    momentsGapH: 6,        // 两条至少隔几小时
    momentsState: {},      // 每个角色的发圈账 { cid: { lastAt, weekStart, weekN } }，本机和云端各自记、合并取大
  };
