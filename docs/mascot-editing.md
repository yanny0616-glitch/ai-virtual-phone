# 小卷：读取、准确修改、预览、撤销

随宿主版本发布后生效。没有新增云函数，也不需要重新安装挂念或拾光。

## 已接入的五项能力

| 能力 | 入口与行为 |
| --- | --- |
| 读取现状 | `读取编辑对象` 返回角色列表/完整角色、真实桌面、主题字段及版本；桌面含内置和自定义 APP 图标名称、ID、页/行/列、Dock、文件夹、组件配置和模板目录 |
| 组件编辑 | `读取DIY组件` 按模板/实例读源码，可按 offset/limit 分段；编辑模板影响全部同款，`widget.update.templatePatch` 复制模板后仅替换一个实例；配置按字段合并；`htmlEdits` 只替换唯一匹配原文 |
| 桌面整理 | 最终布局支持跨页、交换、Dock、文件夹和组件位置；保留全部原有 APP 图标，拒绝重复、越界、重叠、空壳文件夹；外观可改壁纸/图标皮肤/字体/已有主题选项和全局自定义 CSS |
| 内部音乐联动 | DIY 桌面实例共用内部播放器的状态与当前队列；支持播放、暂停、上一首、下一首、进度和打开完整播放器；不支持搜歌和修改歌单 |
| 角色字段 | 按 ID 或唯一名字读取；写入人设、性格、简量人设、标签、时区、头像、微信号和卡内世界书；标签可追加/移除，不必整组覆盖 |

`配角`仍是普通分类标签，本轮不改变记忆库、拾光、挂念的角色筛选和后台策略。内置组件只开放现有配置和位置，不能运行时改写宿主 React 源码。其他旧套件（如聊天 CSS、预设、正则）没有在本轮迁移到统一撤销系统。

## 操作契约

1. 读取返回 `read={scope,id?,revision}`。组件和布局共用 desktop 版本；角色更新按单个角色版本，新建使用 characters 列表版本，主题使用 appearance 版本。
2. `准备修改` 接收 reads、title 和最多 50 个 operations；原生 schema 的 patch/templatePatch 使用 JSON 对象字符串，执行器也兼容文本协议的对象形式。纯函数生成 deltas。只保存草稿，不改变目标内容。多动作先全部校验，图标交换只检查最终状态。模板改尺寸放不下会拒绝整个方案，不自动移除桌面实例。
3. `预览修改` 打开字段差异、DIY 沙箱渲染和桌面布局示意。角色字段用可展开的前后内容；桌面示意不等于实机像素截图，不执行全局 CSS。完整原始 CSS 仍在差异里可查看。
4. `应用修改` 核对读取版本和目标快照，再以一个 IndexedDB 事务提交目标数据和修改记录。工具重试同一已应用方案不会重复创建对象。角色更新还会在同一事务里保留原角色卡版本备份；撤销前也备份当前卡，原角色卡版本界面继续可用。
5. `撤销修改` 校验目标仍等于上次写入值后恢复。其他角色或模板的后续修改保留；同一角色、同一模板、桌面整体或主题整体出现后续修改时拒绝覆盖。撤销新建模板时也检查桌面引用有效性。

用户明确说直接改，可以准备后直接应用；要求先看效果时只生成草稿。对话信息页和桌宠工具抽屉均有“修改记录”，无需模型也可重新打开、应用和撤销。记录保留最近 20 项，总体最多 8MB；导入的图片素材保留在素材库，撤销外观不会删除素材文件。

旧的角色、DIY 创建/更新/摆放/移除工具全部经同一计划器执行，并要求本轮先读取。角色重名会要求 ID；读写字段说明同步扩展。其他普通标签不受 `addTags/removeTags` 影响。

## 音乐与预览桥接

`window.AiPhoneWidget.music`：

```js
const music = window.AiPhoneWidget.music;
const stop = music.subscribe(render);
music.getState().then(render).catch(showError);
// 由点击事件调用，按钮应把 Promise 错误显示给用户。
playButton.onclick = () => music.togglePlay().catch(showError);
nextButton.onclick = () => music.next().catch(showError);
// music.play(), pause(), prev(), seek(seconds), openPlayer()
```

状态为 `{available,track:{id,title,artist,coverUrl}|null,isPlaying,currentTime,duration}`。宿主只转发这些字段，不传播放器存储、完整队列或密钥。订阅每 500ms 检查变化，卸载时移除监听和定时器；请求有 10 秒超时。命令仅接收该实例 iframe 的 `event.source`，并核对协议与实例 ID。

桌面实例、组件挑选器和小卷预览使用同一配置/音乐桥。所有预览只读当前音乐状态，控制会返回明确错误，不改变真实播放。无曲目时控制报“先在音乐 App 选择歌曲”；打开完整播放器不要求已有曲目。脚本错误和未处理 Promise 拒绝每实例暂存最近 10 项，`读取组件诊断` 可查看，卸载后清除。

## 文件与持久化

- `lib/mascot-edit-domain.ts`：纯函数，显式时间/ID/图标目录；校验、构造快照、应用和撤销冲突检查。
- `lib/mascot-edit-store.ts`：资源适配、草稿与记录、原子提交、刷新通知。
- `lib/mascot-edit-tools.ts`：工具 schema、旧入口适配、使用说明；`mascot-tools.ts` 保留统一注册与双协议别名。
- `components/mascot/mascot-edit-review.tsx`：原生 dialog、字段差异、组件效果、桌面示意与记录入口。
- `lib/widget-music-bridge.ts`：隔离 iframe 的音乐 API 与诊断；`music-context.tsx` 复用全局播放器。

`kvCompareAndSetBatch` 先核对内存，再在 IndexedDB 写事务里核对持久值，成功后更新缓存。存储失败不会把失败结果提前写入缓存，也不会留下半批目标写入。另一个页签已改过持久值但本页缓存未同步时拒绝提交，用户需刷新重新读取。它不是全站存储同步系统。

## 验证

- `node scripts/check-mascot-edit.mjs`：实际领域函数、存储适配层、工具执行与双协议注册；覆盖 ID/标签、批量校验、局部 HTML、尺寸冲突、交换/跨页/文件夹/Dock、保存失败、草稿不写目标、重试、撤销和后续修改保护。
- `node scripts/check-mascot-preview.mjs`：仅打包相关 React 模块，使用独立 Chromium profile；真实 iframe 和音乐桥、只读预览、弹窗生命周期、差异/应用/撤销入口、真实 Dexie/IndexedDB 事务与持久冲突。播放器和应用状态使用测试数据，不读取生产用户数据。
- TypeScript `--noEmit` 和改动文件 ESLint；已有 lint 问题与新增问题分开核对。没有运行 Next.js 全量构建，没有调用真实模型，没有做 iPhone 实机或真实音源播放验证。
