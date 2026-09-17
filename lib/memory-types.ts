// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";
import type { ShiguangData } from "./shiguang-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core" | "shiguang";
    shiguang?: ShiguangData;
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    shiguangEnabled: boolean;
    shiguangAutoEnabled: boolean;
    shiguangRoundInterval: number;
    shiguangTokenBudget: number;
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    /** 已不再使用：长期记忆不按条数删除（2026-09-17），字段留着兼容旧配置 */
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    longTermRecallMode: "all" | "relevant"; // all：按预算从新到旧塞满（原来的做法）；relevant：按话题挑、标日期
    longTermRecallTopK: number;
    /** 2.0：短期 / 长期 / 核心预算按当前模型校准后的 token 数判断 */
    calibratedBudgetEnabled: boolean;
    /** 2.2：核心记忆合成过的长期记忆不再注入；核心改为旧核心 + 新增长期合并成一份，旧版留作历史 */
    coreDedupEnabled: boolean;
    /** 2.3：挂念判断模板不带和该角色的私聊短期记忆，后端判断时自带带消息 ID 的最近聊天 */
    guanianJudgeSlimEnabled: boolean;
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * 默认长期总结提示词。占位：{{char}} {{earliest}} {{latest}} {{events}} {{count}}（本批条数）
 * 规则参考 Memory Constellations「航海日志」、糯叽机总结规则、ai-memory-gateway，见 docs/memory-refactor-plan.md。
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是{{char}}的记忆整理助手。下面是 {{earliest}} 至 {{latest}} 之间还没整理过的 {{count}} 条记录（聊天、朋友圈、日记等），请整理成一段记忆日志，供{{char}}以后回忆。

记录：
{{events}}

怎么写：
1. 按时间顺序，按话题或情绪转折分段，每段一行，开头写绝对时间，格式「M月D日 HH:MM～HH:MM · 主题：具体内容」。不要写「今天」「昨天」「刚才」；记录里说的「明天」「周五」「下个月」要换算成具体日期。
2. 写具体发生了什么：做了什么、说了什么、结果怎样。关键原话、称呼、昵称和口头禅用引号保留，并写明是谁说的；人名、地点、物品、作品名照原文写。
3. 约定、承诺、计划要写清：谁答应了谁、什么事、什么时间、什么条件、目前有没有做到。时间和条件不能省略。
4. 普通闲聊、小情绪、随口提到的喜好和近况也要记，一两句写清即可，不要因为普通就省略。
5. 前后说法不一致、被纠正或改变的事，写最新的说法，并注明「改为……」。
6. 只写记录里确实发生的事，不推测、不解读意义；玩笑、猜测和夸张不能写成真实情况。
7. 不要用「讨论了」「交流了」「分享了」「表达了」这类空泛的词，直接写内容。
8. 用第三人称，人物用记录里的名字。长短跟着内容走：内容少就写几行，内容多就多写；不凑字数，也不为压缩字数丢掉时间、原话和约定。
9. 只写这批记录里的内容。只输出日志正文，不要标题、解释、JSON 或代码块。

记忆日志：`;

/**
 * 默认核心记忆提示词。占位：{{char}} {{earliest}} {{latest}} {{events}}
 * 核心是长期记忆的再精炼，也是长期记忆太多、旧条目带不进提示词时的兜底，所以普通细节压短保留，不能略掉。
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是{{char}}的核心记忆整理助手。下面是 {{earliest}} 至 {{latest}} 的长期记忆，请把它们再精炼成核心记忆。长期记忆多了以后，旧的长期记忆可能带不进对话，那时这段时间只剩核心记忆可以回忆，所以要尽量不丢信息。

长期记忆：
{{events}}

重点写清（每项都保留具体内容）：
- 关系身份及其变化，如确认关系、分开、复合、订婚、结婚
- 共同经历里的重要转折和里程碑，如第一次见面、同居、见家长、一起养宠物
- 重要日期（纪念日、生日、约定的日子）和关键人物
- 承诺和约定：内容、时间、条件，目前是否已兑现
- 明确说过的边界、禁忌和相处需求，保留原因和具体说法
- 偏好、习惯和个人情况，如职业、住处、家人

普通细节也要保留，压短写：
- 常聊的话题、日常习惯、近况、反复出现的小事、有代表性的原话和称呼，各用一句话写清
- 一时的情绪和小矛盾，写清起因和结果，一句话即可

只有这些可以省：重复的寒暄和表白、没有依据的推测。

写法：
1. 按时间先后写，每件事带上日期或时间范围。
2. 区分已经发生的事、还没兑现的约定和一方的想法，不要把计划写成已发生。
3. 同一件事合并写，有新进展以最新为准，保留理解变化需要的背景；不同的事不要因为相似合在一起。
4. 保留人名、地点、物品和关键原话，不要概括成「彼此关心」「感情稳定」这类空话。
5. 用第三人称、简洁的中文。长短跟着内容走，信息多就多写，不凑字数，也不为压缩字数丢掉事情。
6. 只输出核心记忆正文，不要标题、解释或 JSON。

核心记忆：`;

/** 2026-09-17 阶段一上线的核心提示词（略去普通细节），存进配置的同样换成新默认。 */
export const PHASE1_CORE_MEMORY_PROMPT = `你是{{char}}的核心记忆整理助手。下面是 {{earliest}} 至 {{latest}} 的长期记忆，请提炼出值得长久记住、会影响以后相处的重要事实。

长期记忆：
{{events}}

要保留：
- 关系身份及其变化，如确认关系、分开、复合、订婚、结婚
- 共同经历里的重要转折和里程碑，如第一次见面、同居、见家长、一起养宠物
- 重要日期（纪念日、生日、约定的日子）和关键人物
- 仍然有效的承诺和约定，写明内容、时间和条件
- 明确说过的边界、禁忌和相处需求，保留原因和具体说法
- 长期稳定的偏好、习惯和个人情况，如职业、住处、家人

要略去（这些已经留在长期记忆里，不会丢）：
- 普通日常闲聊、一时的情绪波动、暂时的小矛盾
- 重复的表白和寒暄
- 没有依据的推测和不确定的内容

写法：
1. 区分已经发生的事、还没兑现的约定和一方的想法，不要把计划写成已发生。
2. 同一件事合并写，有新进展以最新为准，保留理解变化需要的背景；不同的事不要因为相似合在一起。
3. 保留日期、人名和关键说法，不要概括成「彼此关心」这类空话。
4. 用第三人称、简洁的中文分句。信息少就短，信息多可以写到 400 字左右，不凑字数。
5. 这段长期记忆里没有值得长久记住的内容时，只输出「无」。
6. 只输出核心记忆正文，不要标题、解释或 JSON。

核心记忆：`;

/** 2026-09-17 之前的默认长期总结提示词。设置页保存过会整份写进配置，读配置时和它全文一致的换成新默认。 */
export const LEGACY_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/** 2026-09-17 之前的默认核心记忆提示词，迁移规则同上。 */
export const LEGACY_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

/** 设置页保存过的旧默认提示词换成新默认；用户改过的不动。 */
export function migrateMemoryPrompts(config: MemoryConfig): MemoryConfig {
    const same = (value: string | undefined, legacy: string) => typeof value === "string" && value.trim() === legacy.trim();
    return {
        ...config,
        ...(same(config.summarizationPrompt, LEGACY_SUMMARIZATION_PROMPT) ? { summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT } : {}),
        ...(same(config.coreMemoryPrompt, LEGACY_CORE_MEMORY_PROMPT) || same(config.coreMemoryPrompt, PHASE1_CORE_MEMORY_PROMPT) ? { coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT } : {}),
    };
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    shiguangEnabled: true,
    shiguangAutoEnabled: true,
    shiguangRoundInterval: 20,
    shiguangTokenBudget: 800,
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    longTermRecallMode: "all",
    longTermRecallTopK: 8,
    calibratedBudgetEnabled: false,
    coreDedupEnabled: false,
    guanianJudgeSlimEnabled: true,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
