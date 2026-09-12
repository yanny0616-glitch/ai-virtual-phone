# 陪眠 APP 架构

独立 APP，数据全在 APP 自己的 db；宿主只提供通用 SDK（角色、`ai.generate`、`voice.*`、`media.*`、`db`、`chat.writeHistory`、`network.fetch`）。

## 目录

`src/domain/*.mjs` 是纯函数 ESM，Node 测试直接 import；`src/**/*.js` 共享一个闭包，顺序见 `src/bundle.json`。`scripts/build-pei-mian.mjs` 把它们合成单文件 `index.html`，域模块以 `PmRhythm` / `PmStats` / `PmMixer` / `PmWav` 四个常量暴露给闭包，`assets/sources.json` 注入成 `SOUND_SOURCES`。

| 目录 | 职责 |
|---|---|
| `domain/rhythm` | 节奏预设、内容方向、把「段数 / 字数 / 间隔」算成时间表（缓出曲线：前密后疏） |
| `domain/stats` | 夜记口径（凌晨 6 点前算前一晚）、入睡时刻相对 18:00 的分钟数（23:30 和 01:10 能平均）、周汇总、月历格 |
| `domain/mixer` | 多层立体声混音（44.1k）：随机起点 + 等功率交叉淡化循环（左右声道共用起点）+ RMS 拉平 + 可选慢 LFO 起伏 + tanh 软限幅；最多 20 秒的渐弱片段；重采样 |
| `domain/wav` | Float32 → 16-bit WAV dataURL |
| `core/runtime` | `$`、toast、底部弹层、视图切换、事件总线 |
| `data/storage` | `settings` 一行、`nights` 每晚一行、`mixes`、`library`（商店下载 / 导入的声音） |
| `audio/catalog` | 内置 19 个声音的目录、分类、图标、7 个内置组合 |
| `audio/engine` | 解码（`OfflineAudioContext.decodeAudioData`）→ 混音 → WAV → `media.put` → `voice.play({ channel: "ambience", loop: true })`；换层重合成再切；渐弱 = 非循环递减尾巴 |
| `audio/store` | Freesound 搜索（浏览器直连）、下载（`proxy: true` 拿二进制）、导入、删除 |
| `session/sleep` | 入睡会话：建夜记 → 开声景 → 分段 `ai.generate` + `voice.tts` + `voice.play` → 定时渐弱；躺着说话（`voice.stt` → 一句回话）；醒来补数据 + 早安一句 |
| `ui/*` | 五个页面 + 主题 / 星空 |

## 关键决定

- **声景在 APP 内合成**。宿主环境音只有一条通道、播放中改不了音量，所以叠加、音量、起伏在 APP 里算成一段 48 秒 44.1kHz 立体声 16-bit 循环体（约 8MB WAV）交给宿主。改层后延迟 400ms 重合成，切换时有一下接缝，接受。渐弱另按最多 20 秒一段合成和顺序播放，避免整段音频超过宿主媒体上限。
- **内置声音不随包发，首次用时下载**。`assets/sources.json` 只记 Freesound id、作者和 `preview-hq-mp3`（128 kbps、44.1k 立体声）地址；第一次点某块声音时在 iframe 里直接 `fetch`（预览地址带 `Access-Control-Allow-Origin: *`，不经宿主代理，也就没有代理 2,000,000 字符 base64 的上限）→ `media.put` → `library` 表一行 `builtin:true`。解码结果按 key 缓存在内存。安装包因此只有 50KB，也能过市场 5MB 的门槛。
- **为什么不用原始 WAV/FLAC**：Freesound 原文件要 OAuth2 才能下，API key 只给预览；而且 48k/24bit 一段就十几 MB，宿主 `media` 存 base64 也吃不消。128k mp3 对雨、风、噪音这类宽频声在睡眠音量下已听不出差别。
- **夜记以「入睡当晚」为键**，凌晨 6 点前入睡归前一天；同一晚再点「睡了」不建新记录，起夜次数 +1。
- **说话链路**：`ai.generate` 走 `presets.json` 的 `["peimian", lull|insomnia|reply|morning|weekly]`；前几段作为 `messages` 回传避免重复。TTS 失败只显示字幕。
- **宿主打包脚本改成递归**（`scripts/lib/custom-app-package.mjs`），并关掉 JSZip 自动建目录条目（否则目录带当前时间，zip 字节不稳定）。宿主 `guessMime` 补了 mp3 / m4a / wav / ogg。

## 验证

`npm run check:pei-mian-app`（领域层 + 产物一致性）。样式预览：`node /root/vibe-coding/float/tools/shoot-pei-mian.mjs`（假 SDK + 无头 Chromium，出 13 张图到 `float/screenshots/pei-mian/`）。不跑 Next 全量构建、不调真实模型。

未做：睡前故事、呼吸引导、仪式清单、闹钟叫醒（见 `float/app-ideas.md`）。

## 0.3.1：会话取消、到点停止与有界渐弱

渐弱使用 `fadeSegment`，每段最多 20 秒、44.1kHz 立体声 WAV 约 3.4MiB，整段包络和采样偏移连续；每段结束删除临时媒体。上传/播放失败时停止旧循环，序号变化的旧渐弱不操作新会话。段间仍有宿主切换接缝，不承诺无缝播放。

入睡会话使用独立对象和绝对截止时间；生成、TTS、STT 及等待返回后都核对会话身份与期限。停止期间阻止新会话开始，过期返回不朗读、不写新夜记。到点停止人声、背景音及 STT，保存本轮最后一句；定时结束不填写实际醒来时间。浏览器若被系统完全挂起，JS 定时无法保证后台准点执行，恢复后时钟检查会补停。

宿主新增 `voice.stopSTT({requestId, cancel?})`，沿用 `voice.stt` 权限；松手结束对应 STT 并等待最终结果，取消丢弃文本。它不操作独立的 `voice.record` 录音器。陪眠用 pointer capture 接收移出按钮后的松手事件。需要宿主与 APP 一起更新。

验证新增 `scripts/check-pei-mian-session.mjs`，使用真实会话/引擎源码及模拟宿主、时钟，覆盖会话隔离、截止时间、渐弱分段与失败兜底、STT 停止。手机锁屏整夜实测仍待进行。

## 0.3.2：宿主播放所有权与试一句取消

宿主每个音频通道有 revision；在读取媒体前登记，stop、新 play 与卸载使旧请求失效。迟到读取不创建 object URL，不启动音频；旧 play 的失败回调不得清理新请求的音频。取消返回 `{ok:false,cancelled:true}`，正常单次播放仍等待结束并释放 URL。

话术页的试一句有独立任务标识和角色快照；离页、换角色或启动正式入睡会话会取消预览。生成/TTS 返回后复核任务归属；只有发起过播放的任务才停止人声通道，正式会话等待该停止完成再开始。停止失败允许重试。其他全量审阅发现仍待处理。

专项 `check-pei-mian-playback-ownership.mjs` 执行真实宿主播放分支及试一句源码，验证媒体读取中停止/替换/卸载、旧播放失败不误停新播放、URL释放、迟到生成/TTS、角色切换及停止等待。

## 0.3.3：夜记唯一性、清空与入层校验

`PmStats.uniqueNights` 按日期归一旧记录，闭合睡眠区间取并集；保留备注，写回时用 `mergedNightIds` 标记原始行已被归并，不物理删除历史原件。同晚再次入睡复用记录，`sleepIntervals` 保存已结束睡眠段，`segmentSleepAt` 记录本段开始，累计时长不含中途已记录的清醒时间，段数累计。

`writeData` 串行保存夜记、设置和下载落库；清空提升 `dataEpoch`、取消延迟保存并等待已启动写入。所有表按500行循环删除，settings 删除重建，使用独立深拷贝默认值。删除失败明确报错，不把部分完成当成功。晚到下载/导入、周评、早安用 epoch 防止清空后回写；清空解码缓存并恢复默认定时。本版本没有扩展到独立试听临时媒体的常规生命周期清理。

声音点击用 pending key 防重复，完成后重新核对当前组合、操作版本及六层上限；套用组合使旧下载入层操作失效，已保存的重复层在读取/套用时归一。

专项 `check-pei-mian-data-integrity.mjs` 使用真实存储、会话与声音操作源码，验证同晚复用/清醒间隔、旧重复读取写回、501行清空、周评/默认值残留、在途上传与旧写入失效、重复点击及七个并发下载。仍不对手机现存库进行现场操作。
