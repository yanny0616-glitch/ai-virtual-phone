# 整体复查 R1–R3 修复与验收（2026-09-07）

> 历史记录：以下结论、版本与发布状态保留自记录当时，不代表当前源码或线上状态；归档不表示问题全部解决。见[归档导航](../README.md)。

R1、R2、R3 已完成本地修复，相关自动验证通过。未提交、未推送、未部署，未连接用户个人 Supabase，也未进行真实手机后台验证。本轮不改变 A6 暂缓、B18 待核实的范围。

## 现在修好的行为

| 编号 | 修复与正确行为 | 自动验证 |
|---|---|---|
| R3 / A7 | IndexedDB 升级为版本 2，整批消息与收取凭据同事务保存；重试按持久凭据确认，绝不把缓存正文重新写回。编辑、删除全部气泡后，凭据仍存在。空正文也记录凭据，避免确认重试重复处理插件。现实桥固定 ID 输入在重试时只确认已有记录，不写回陈旧正文。 | 真实 Chromium 双页面：互斥、确认失败、编辑、整轮删除、页面退出、版本 1 升级及旧批次补凭据。存储专项覆盖消息、会话和凭据任一写入失败时整批回滚。 |
| R2 / B11 | 手机从已提交的数据库读取整轮气泡，网关将其保存为一条原子快照；云端按批次独立读取，部分气泡或最近 200 条窗口都不能代表整轮。编辑使用完整新快照，空快照明确表示整轮删除。 | 实际手机镜像构造/上传代码 → 实际网关 → 共享历史函数 → 约定门禁：50 条边界、查询截断、编辑、整轮删除、损坏快照及读取失败。 |
| R1 / A5 | 删除“只凭补收前后 2 分钟”的排除逻辑。没有正文对应证据的旧格式新发言仍进入事实历史与约定门禁。完整唯一匹配和确实含糊的同文匹配保留原有处理。 | 18:52 补收旧回复、18:53 真正另说新约定：新约定仍可触发核对。旧同文歧义专项同时通过。 |

整轮快照使用现有 `push_chat_mirror` 表，`media_type=response_batch`，无个人云 SQL 迁移。普通镜像查询排除这类内部记录，防止 JSON 元数据进入普通聊天摘要。网关能力 `chat-mirror-batches` 用于新旧版本协商；旧网关仍走原有单条镜像兼容路径。本轮修改宿主与三个云函数，不修改挂念沙盒源码，现有 0.9.27 ZIP 不变，配套调度 schema 仍为 12。静态缓存版本升为 v25。

在没有整轮快照的历史数据中，部分气泡不能替代完整 outbox，暂以完整原回复为准。旧数据缺少身份或删除凭据时，不能凭空分辨独立发言、用户删减和丢失的镜像；升级后应同步最新镜像，不能宣称历史信息全部自动还原。新快照链路能明确保存编辑与删除。

## 本轮验证证据

| 检查入口 | 本轮结果 |
|---|---|
| `scripts/check-gua-nian-integrated-history.mjs` | 8 组场景通过，运行实际客户端、网关和历史逻辑，网络与数据库使用受控数据。 |
| `scripts/check-outbox-cross-page.mjs` | 真实 Chromium / Web Locks / IndexedDB 验证通过，包含编辑、删除和升级；传输与回复解析使用测试替身。 |
| `scripts/check-persistence-and-proxy.mjs`，过滤消息补收相关用例 | 19 项通过，覆盖原时间、原排序、原子落盘、确认重试、空正文与来电。 |
| `scripts/check-fork-regressions.mjs`，过滤镜像用例 | 18 项通过，覆盖并发上传、晚到确认、新编辑、清空、超时、关闭/重新开启和旧云兼容。新增过滤入口避免后续专项附带运行整套依赖。 |
| `check-cloud-message-repair`、`check-deferred-reply-cloud`、`check-push-outbox-plugins` | 原消息链路、延后接续与插件专项通过。 |
| `check-gua-nian-scheduler`、`check-gua-nian-promise-repair`、`check-gua-nian-promise-recheck`、`check-gua-nian-a5-b19`、`check-gua-nian-b20-b17` | 调度、约定、缺失时区、旧字段和撤销专项通过。 |
| 宿主 `tsc --noEmit`、三个独立云函数类型检查、相关文件 ESLint | 通过。云函数按独立模块校验，没有将三份自包含函数混为同一全局脚本。 |
| `push:build-dist`、`check:push`、`gua-nian:check`、`git diff --check` | 公开云函数副本和源码一致，APP 产物一致，差异检查通过。没有运行本机 Next.js 全量构建。 |

日志保存在本地 `out/integrated-fix/`。初次类型命令误扫备份源码，已将备份移出仓库并重跑；首次存储测试替身未返回事务结果，且未模拟新页共享数据库，已校正替身，真实浏览器与后续专项均通过。这些失败没有被静默当作通过。

## 如何减少遗漏

原审计 A1–A8、B1–B21 共 29 项逐项保留在下表，没有用“只剩两个”代替完整清单。每项区分本轮执行、前轮证据和未验证状态；本地通过不等于线上生效。新发现的 R1–R3 已转为期望正确行为的回归测试，修复后不能继续使用“复现故障成功”作为通过依据。

### 原清单覆盖表

| 原编号 | 原问题 | 验证状态与证据 |
|---|---|---|
| A1 | 延后回复完成后漏接用户下一句 | 本轮：check-deferred-reply-cloud（晚到确认与接续） |
| A2 | 因为期间出现另一条角色消息而误丢回复 | 本轮：check-cloud-message-repair（期间出现另一回复） |
| A3 | 没有通知订阅便不取消息 | 本轮：check-cloud-message-repair（无订阅前台补收） |
| A4 | 页面前台不补收 | 本轮：check-cloud-message-repair（轮询、回前台、恢复网络） |
| A5 | 无编号旧镜像被重复当作发言 | 本轮：check-gua-nian-integrated-history + check-gua-nian-a5-b19 |
| A6 | 未修，按此前约定暂缓 | 未修；用户要求暂缓，不纳入本轮验收 |
| A7 | 同源多页面同时收取重复落盘 | 本轮：check-outbox-cross-page + 19 项消息存储专项 |
| A8 | 相同 trigger_key 的不同回复被误丢 | 本轮：check-cloud-message-repair（同触发键不同输出） |
| B1 | 空 sessionId 导致复核停摆 | 本轮：check-gua-nian-promise-repair / promise-recheck |
| B2 | 缺 schema 后生成无限重试 | 本轮：check-gua-nian-scheduler（缺迁移停止与有限退避） |
| B3 | 手机和云端给同一约定各挂一条 | 本轮：check-gua-nian-promise-repair（云端唯一预约与同版输出） |
| B4 | 过点约定违反宿主 60 秒预约下限 | 本轮：check-gua-nian-promise-repair（宿主预约下限） |
| B5 | 新增约定裁决被旧快照覆盖 | 本轮：check-gua-nian-promise-recheck；前轮 SQL 原子追加专项通过 |
| B6 | 同版本已发约定次日重新挂 | 本轮：check-gua-nian-promise-repair；前轮 promises-sql 跨天专项通过 |
| B7 | 手机旧账本回退云端改期 | 前轮 promises-sql / scheduler-sql 版本保护专项通过；本轮未改 SQL、未重复执行 |
| B8 | 改期后本机旧约定仍发 | 本轮：check-gua-nian-promise-repair（改期撤旧及撤销失败恢复） |
| B9 | 缺能力时报错但计划已经半保存 | 本轮：check-gua-nian-promise-repair（能力检查前拒绝半保存） |
| B10 | 账本操作用旧 items 覆盖云端新增预约 | 前轮 scheduler-app / scheduler-sql 专项通过；本轮未改计划上传或 SQL |
| B11 | 同轮历史注入两遍、时区不一致 | 本轮：check-cloud-message-repair + check-gua-nian-integrated-history |
| B12 | 角色自己的消息触发重复普通起念 | 本轮：check-gua-nian-scheduler（角色消息只核对约定） |
| B13 | 复核异常持续失败并占队首 | 本轮：check-gua-nian-scheduler（持久退避与停止） |
| B14 | 成文后故障导致丢结果或重复模型调用 | 本轮：check-cloud-message-repair + check-gua-nian-scheduler（成文暂存后恢复） |
| B15 | 被动回复占主动间隔、每分钟反复派发 | 本轮：check-gua-nian-scheduler（被动回复与主动间隔） |
| B16 | 旧计划写回、约定挤占普通配额 | 本轮：check-gua-nian-scheduler；前轮 scheduler-sql 并发写保护通过 |
| B17 | 已发但回执滞后时误记撤销 | 本轮：check-gua-nian-b20-b17（任务状态、执行中、已成文与取消） |
| B18 | 待核实，不能标为已修或已证实故障 | 待核实；按用户要求排除，异常起床时间未专项验证 |
| B19 | 缺失时区误作 UTC、旧时刻反推偏移 | 本轮：check-gua-nian-a5-b19（缺失、明确零、IANA 和偏移恢复） |
| B20 | 旧数据库缺批次列导致镜像上传失败 | 本轮：check-gua-nian-b20-b17（精确缺列兼容，其他错误保留） |
| B21 | 云端补收全量重排历史 | 本轮：19 项消息存储专项中的原时间、原排序及桥输入测试 |

## 部署后的实测仍未完成

以下是待验收内容，并非声称已经测试通过：真实手机关闭/恢复页面后的收取与时间显示；用户个人云的三个函数与 schema 12 实际版本；通知权限和系统后台限制；手机编辑/删除后的整轮镜像同步。需要宿主发布、个人云更新后，在相同会话按“生成 → 本机落盘 → 收取确认 → 镜像快照 → 下一轮约定核对”核对时间和批次编号。

建议先检查本报告的覆盖表，再安排发布后实测。不能承诺零遗漏；可以承诺不把未验证项标成通过，不把本地修改说成已经部署。
