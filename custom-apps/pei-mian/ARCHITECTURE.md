# 陪眠 APP 架构

独立 APP，数据全在 APP 自己的 db；宿主只提供通用 SDK（角色、`ai.generate`、`voice.*`、`media.*`、`db`、`chat.writeHistory`、`network.fetch`）。

## 目录

`src/domain/*.mjs` 是纯函数 ESM，Node 测试直接 import；`src/**/*.js` 共享一个闭包，顺序见 `src/bundle.json`。`scripts/build-pei-mian.mjs` 把它们合成单文件 `index.html`，域模块以 `PmRhythm` / `PmStats` / `PmMixer` / `PmWav` 四个常量暴露给闭包，`assets/sources.json` 注入成 `SOUND_SOURCES`。

| 目录 | 职责 |
|---|---|
| `domain/rhythm` | 节奏预设、内容方向、把「段数 / 字数 / 间隔」算成时间表（缓出曲线：前密后疏） |
| `domain/stats` | 夜记口径（凌晨 6 点前算前一晚）、入睡时刻相对 18:00 的分钟数（23:30 和 01:10 能平均）、周汇总、月历格 |
| `domain/mixer` | 多层混音：随机起点 + 等功率交叉淡化循环 + RMS 拉平 + 可选慢 LFO 起伏 + tanh 软限幅；渐弱尾巴；单声道化与重采样 |
| `domain/wav` | Float32 → 16-bit WAV dataURL |
| `core/runtime` | `$`、toast、底部弹层、视图切换、事件总线 |
| `data/storage` | `settings` 一行、`nights` 每晚一行、`mixes`、`library`（商店下载 / 导入的声音） |
| `audio/catalog` | 内置 19 个声音的目录、分类、图标、7 个内置组合 |
| `audio/engine` | 解码（`OfflineAudioContext.decodeAudioData`）→ 混音 → WAV → `media.put` → `voice.play({ channel: "ambience", loop: true })`；换层重合成再切；渐弱 = 非循环递减尾巴 |
| `audio/store` | Freesound 搜索（浏览器直连）、下载（`proxy: true` 拿二进制）、导入、删除 |
| `session/sleep` | 入睡会话：建夜记 → 开声景 → 分段 `ai.generate` + `voice.tts` + `voice.play` → 定时渐弱；躺着说话（`voice.stt` → 一句回话）；醒来补数据 + 早安一句 |
| `ui/*` | 五个页面 + 主题 / 星空 |

## 关键决定

- **声景在 APP 内合成**。宿主环境音只有一条通道、播放中改不了音量，所以叠加、音量、起伏、渐弱全部在 APP 里算成一段 90 秒 32kHz 单声道循环体交给宿主。改层后延迟 400ms 重合成，切换时有一下接缝，接受。
- **声音文件走 assets，不走 db**。`app.getAssetUrl` 拿到 dataURL 后 `fetch` 解码；解码结果按 key 缓存在内存，不落库。用户下载 / 导入的声音存 `media.put` 引用。
- **单个资源 ≤ 2MB** 是宿主限制，所以内置全部用 Freesound 64k 预览音；商店只列 ≤ 170 秒的（宿主代理二进制上限约 1.5MB）。
- **夜记以「入睡当晚」为键**，凌晨 6 点前入睡归前一天；同一晚再点「睡了」不建新记录，起夜次数 +1。
- **说话链路**：`ai.generate` 走 `presets.json` 的 `["peimian", lull|insomnia|reply|morning|weekly]`；前几段作为 `messages` 回传避免重复。TTS 失败只显示字幕。
- **宿主打包脚本改成递归**（`scripts/lib/custom-app-package.mjs`），并关掉 JSZip 自动建目录条目（否则目录带当前时间，zip 字节不稳定）。宿主 `guessMime` 补了 mp3 / m4a / wav / ogg。

## 验证

`npm run check:pei-mian-app`（领域层 + 产物一致性）。样式预览：`node /root/vibe-coding/float/tools/shoot-pei-mian.mjs`（假 SDK + 无头 Chromium，出 13 张图到 `float/screenshots/pei-mian/`）。不跑 Next 全量构建、不调真实模型。

未做：睡前故事、呼吸引导、仪式清单、闹钟叫醒（见 `float/app-ideas.md`）。
