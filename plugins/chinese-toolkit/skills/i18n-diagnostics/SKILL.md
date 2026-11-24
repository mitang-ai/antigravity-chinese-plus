---
name: i18n-diagnostics
description: 检查 Antigravity 汉化状态、适配上游更新、诊断漏翻、补充词条或验证发布时使用。
---

# 本地化维护与诊断

先定位已有的 `antigravity-chinese` 仓库，检查其 `package.json` 身份；以下命令在该仓库根目录执行。阅读 `CONTRIBUTING.md` 的“更新维护与发版”流程，以该流程作为维护步骤的单一来源。

## 上游更新与长期资产延续

核查 https://antigravity.google/docs/changelog 中的目标版本和灰度说明，逐项分析对词库、内容保护、安装/还原、实时翻译插件（Google 免费翻译通道 + 详情页悬浮切换栏）、扩展及插件的影响。结合实际客户端与测试确定修复，记录尚未验收的功能。

客户端官方升级会覆盖 `app.asar`，但以下本地资产**永久独立保存**：
1. 本仓库词库与安装器代码（含 `core/live-translate-main.js`、`core/live-translator.js`）。
2. 全局插件目录 `~/.gemini/config/plugins/chinese-toolkit`。
3. Google 实时翻译持久化缓存 `~/.gemini/antigravity/i18n-live-cache.json` 与配置 `i18n-live-config.json`。

当 Antigravity 升级新版本导致汉化失效时，可直接在本仓库根目录运行 `node cli.js install`（以及按需 `node cli.js install-plugin`）恢复全套静态词库与实时翻译插件；若出现新增未覆盖界面，再按“修正与验证”流程提取前端 bundle 补译。

## 状态与漂移

- `node cli.js status`：检查桌面客户端、备份与汉化状态。
- `node cli.js status:vscode`：检查已安装的 VS Code 扩展。
- `npm run scan:drift -- <官方前端-bundle.js> --report <报告.json>`：分析明确来源的前端脚本。没有有效文件时不能声称完成漂移检测。
- `npm run audit:ui -- --bundle <官方前端-main.js>`：核对已审查组件清单的来源和文案映射；上游变化时按贡献指南重新提取和审查完整组件。只运行 `npm run audit:ui` 不验证当前上游或实机。

漂移指标只反映前端候选字符串的启发式匹配，不代表整个客户端的翻译覆盖率。作者内容按贡献指南保留原文；扫描器不读取本机技能或插件清单，也不将作者说明计作漏译。报告样本需结合实际界面判断，不能直接批量加入词库。

## 修正与验证

编辑 `dict/src/` 的分层词库，运行 `npm run build:dict` 同步两个生成词库。运行 `npm test` 与 `npm run audit`；测试入口和数量以当前 `package.json` 与输出为准。

保护品牌、模型信息、代码、终端、可编辑内容和用户数据；UI 短词使用精确匹配。安装器修改先验证副本的安装与还原，保留纯净备份及上游 unpacked 文件。实机检查不触发未授权的会话、自动化、录音或云端执行。

按贡献指南记录来源、验证范围、文档对齐与发布结果。当前正在使用的客户端与项目源码发布分别处理，不以强制关闭会话完成验证。
