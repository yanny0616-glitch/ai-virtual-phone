# 文档导航

日常查阅从这里进入；阶段性的排查、修复、验收与调研记录统一放在 [archive/](archive/README.md)。归档不表示问题全部解决，历史记录中的“已修复”“未发布”等状态只适用于记录当时。

## 功能与维护说明

| 文档 | 用途 |
| --- | --- |
| [Fork 改动清单](fork-changes.md) | 本项目相对上游的功能、部署与修复记录；历史条目中的版本状态需结合当前源码与实际部署核对 |
| [小卷编辑能力](mascot-editing.md) | 读取、修改、预览与撤销的使用说明 |
| [资源集市](resource-hub.md) | 资源仓库结构、下载导入与运营流程 |
| [微信云端助手](weixin-cloud-assistant.md) | 部署、停用、自更新与开发者自测 |
| [成年审核部署](verify-setup.md) | 激活码申请与审核流程；原文含 Netlify 配置说明，本 VPS 的部署方式见仓库外 AGENTS.md |
| [拾光核心记忆提示词](shiguang-core-memory-prompt.txt) | 可复制使用的核心记忆整理模板 |

## 数据库脚本

SQL 保留在本目录原路径，供部署、产物生成与现有文档引用。下面按用途导航，不是要求依次执行所有脚本；执行条件以各文件说明和目标项目为准。

| 用途 | 脚本 |
| --- | --- |
| 站点初始化 | [整合初始化](supabase-all-in-one.sql)、[账号与会话](account-supabase.sql)、[成年审核](verify-supabase.sql) |
| 市场与互动 | [应用市场](custom-app-market-supabase.sql)、[游戏大厅](game-hall-supabase.sql)、[黑市](black-market-supabase.sql)、[便签墙](notewall-supabase.sql)、[联机数据](online-play-supabase.sql)、[内容管理](moderation-supabase.sql) |
| 独家特调专用项目 | [独家特调](mixology-supabase.sql) |
| 个人云推送 | [个人推送 schema 正本](personal-push-supabase.sql)；公开副本由 `npm run push:build-dist` 生成 |
| 旧版推送维护与迁移 | [站点共享推送](push-supabase.sql)、[扫描频率迁移](push-cron-10s-migration.sql)、[快捷指令接续迁移](push-shortcut-resume-migration.sql) |
| 空间与流量维护 | [空间体检与清理](supabase-cleanup.sql)、[流量优化](supabase-egress-optimization.sql)、[特调与大厅流量优化](supabase-egress-preventive.sql) |

## 历史排查与调研

到 [归档导航](archive/README.md) 按主题和日期查找挂念、云消息及工坊的原始记录。挂念 2026-09-07 的总表与后续修复记录在导航中分别列出，避免把较早的结论当成最新状态。

## 后续文档放置规则

持续维护的功能和部署说明放在本目录，并加入本导航。一次性的排查、修复、验收或调研放在 `archive/<主题>/`，新文件名使用 `YYYY-MM-DD-主题.md`，同时补充归档导航；已有归档保留原文件名，便于按旧名称搜索。

历史记录保留当时的证据和验证边界，后续结论通过链接补充。新增或移动 SQL 前检查脚本依赖，尤其不要移动 `personal-push-supabase.sql` 正本。
