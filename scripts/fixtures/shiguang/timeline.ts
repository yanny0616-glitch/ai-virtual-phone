export const loadNativeTimeline = () => [
    { id: "source-user", timestamp: new Date().toISOString(), authorType: "user", sourceApp: "chat", sourceDetail: "direct", content: "[私聊] 你: 9月12日我们去海边好不好？临时改计划会让我有点不安，别等到快出门才告诉我。" },
    { id: "source-ai", timestamp: new Date().toISOString(), authorType: "character", sourceApp: "chat", sourceDetail: "direct", content: "[私聊] 林予: 记下了，11号晚上给你准信。" },
];
