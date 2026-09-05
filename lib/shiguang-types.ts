export const SHIGUANG_CATEGORIES = ["共同经历", "约定与承诺", "喜好与边界", "人物与关系", "重要信息"] as const;
export type ShiguangCategory = typeof SHIGUANG_CATEGORIES[number];
export type ShiguangData = {
    title: string;
    categories: ShiguangCategory[];
    reason: string;
    story: string;
    details: Array<{ label: string; value: string }>;
    significance: string;
    /** Compact prompt text, never rendered in the memory card. */
    stableSummary: string;
    recallSummary: string;
    keywords: string[];
    dueAt?: string;
    status: "remembered" | "pending" | "completed" | "changed";
    followup: string;
    firstEventAt: string;
    lastEventAt: string;
    /** User edits take precedence over automatic rewriting. */
    userEdited?: boolean;
    deletedAt?: string;
};
