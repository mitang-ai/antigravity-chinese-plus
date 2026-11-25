# v3.4.0 适配 Antigravity App 2.35.0

2026-11-23 在 Windows 11 x64 核对到本机官方安装的桌面程序与 ASAR 均为 **2.35.0**。由于本机尚未安装任何历史汉化补丁，本次以原生 2.35.0 的 `app.asar` 与从 `language_server.exe` 内嵌静态 ZIP 提取的前端资源为直接校对与验证基准。

- 官方原版 `app.asar` 大小为 6,729,546 字节，SHA-256 为 `99ff7f6cf1219f46c8437df65ca866e384836b5230adba8efd91b3152f823e15`，包含 790 个打包文件与 377 个外置文件。
- 提取的前端 `main.js` 大小为 12,798,818 字节，SHA-256 为 `f039eca519f153aeac9a0f1d10abc7afd8ff4b8009ef78d684669a3c7955f54d`。
- 官方更新日志 `https://antigravity.google/docs/changelog` 暂未公开列出 2.35.0 的完整条目，故本次变更新增项以本机官方实包二进制及前端源码提取结果为准。

## 主要变化与适配处理

| 模块 / 变化面 | 本版处理 |
| --- | --- |
| 设置与浏览器隐私 | 补齐通用、外观、浏览器、自定义扩展、应用与账号中的新增设置标签及长描述（含防休眠、菜单栏常驻、自动更新提示、浏览器浏览数据与按站点 Cookie 清理弹窗、内置浏览器右键菜单等）。 |
| 模型、配额与插件权限 | 补齐模型选择、编排器模型选择、AI 额度超额抵扣、插件权限、Build With Google 插件、管理钩子、市场分类（上下文限定翻译）与无应用状态文案。 |
| 侧栏、旁路提问与引导 | 适配新版侧栏定制（收件箱模式、分组/排序锁定提示、显示自动化/插件）、新建旁路提问与分支工作区续接文案、以及新版引导页（Onboarding）。 |
| 自动化触发器与内联卡片 | 补齐触发器调度与 CEL 表达式助手说明、2.35.0 新增内联状态（`No longer active`、`Answered in chat`、`Dismissed`）及工具权限审批分类。 |
| 远程控制与限额提示 | 补齐远程控制实例、SSH/Git/Cog/CitC 操作及远程智能体/环境/会话次数上限提示；保留 `Orchestrator`、`ELMO Composite`、`CitC workspace type` 等内部技术标识。 |
| Swarm 面板与插件目录 | 在 `dict/scoped/swarm.json` 中补齐 Hive/Mentions 视图切换、GIF 动图导出弹窗、Waiting/Killed 状态等新增词条与选择器；在 `dict/scoped/official-plugin-descriptions.json` 中同步 2.35.0 本机市场缓存中更新/新增的 6 条官方及合作伙伴插件短介绍。 |
| Electron 主进程与原生页面 | 扩展 `cli.js` 补丁覆盖范围：在原有 9 个核心文件基础上新增 `dist/remote/disconnectedPage.js`（SSH 断连/重连页）、`dist/webviewPopupSecurity.js`（连接安全信息弹窗与右键菜单）、`dist/deviceChooser.js`（HID/USB/串口设备选择器）、`dist/remote/signInCallback.js`（登录回调页），并补齐 `dist/main.js` 的 `WSL setup failed`。 |
| 正则假阳性治理 | 收紧 `patterns.json` 中过宽的 `finished` 与 `Set up` 规则，消除 `script finished` 和 `Set up my environment` 两条半英半中假阳性残片；补充 45 组 2.35.0 动态模板正则。 |

## 验证范围

- `npm run build:dict`：5,055 条精确词条与 445 组级联正则全部通过词库门禁。
- `npm run audit:ui -- --bundle <extracted 2.35.0 main.js>`：核对 [app-2.35.0-ui.json](../../test/fixtures/app-2.35.0-ui.json) 全部 UI 字面量与保留决定通过。
- `npm run audit`：45 项全链路静态一致性检查全部通过。
- `npm test`：全套 13 个测试入口全部通过（含 JSDOM 内容边界、Swarm 面板、ASAR 生命周期、词库质检等）。
- 本机安装：在受保护智能体会话下通过无损预注入模式生成 `app.asar.staged` 与后台替换守候进程，待用户重启客户端后完成实机界面生效；VS Code 扩展未在本机安装，未作实机检查；macOS/Linux 范围为跨平台自动化回归。

## v3.4.2 边界修复与生命周期加固

针对社区审查中指出的 4 项生命周期与边界漏洞完成专项修复与自动化回归：

1. **防过期 `app.asar.staged` 降级与原子回滚**：预构建时生成 `app.asar.staged.meta.json` 绑定 `sourceFingerprint` 与 `stagedFingerprint`；替换阶段统一走 `commitStagedSwap()` 校验磁盘 `app.asar` 指纹，若官方已升级则判为 `stale` 并清理过期包，写元数据异常时自动回滚恢复原包。
2. **保护受限会话禁强杀边界**：`manualInstall()` 严格遵循 `isProtectedEnvironment()`，在 `AGY_NO_KILL=1` 或智能体会话中彻底禁用交互强杀分支。
3. **纯 VS Code 扩展用户安装通路**：`manualInstall()` 同时探测 `asarPath` 与 `vsExtDir`，无桌面端仅装有 VS Code 扩展时允许直接安装扩展补丁，不再死循环阻塞。
4. **斜杠菜单 `dir="rtl"` 保护与高亮动态重译**：`isProtectedBoundary()` 显式保护 `[data-testid="menu-option-description"][dir="rtl"]`，防止单节点路径如 `Before` 误译；`translateElement()` 与 `recordMutations()` 统一处理单/多高亮节点及动态替换恢复。

## 2.35.1 兼容性验证与 v3.4.3 上游同步

2026-11-25 核对本机 Windows x64 客户端已升级至官方 **2.35.1**（`Antigravity.exe` FileVersion `2.35.1`、`resources\app.asar` 体积 6,729,546 字节、SHA-256 `9f0aad7274795d7fbde04931d96b348dcfc5f3d81d7373e6b70aeb09307442df`，外置文件 377 个），升级覆盖了原本地汉化补丁（保留 `~/.gemini/antigravity/i18n-live-cache.json` 长期缓存与全局社区插件）。

- **前端资源比对**：从 `2.35.1` `resources\bin\language_server.exe` 提取的前端 `main.js`（12,798,818 字节，SHA-256 `f039eca519f153aeac9a0f1d10abc7afd8ff4b8009ef78d684669a3c7955f54d`）与 `2.35.0` 逐字节一致；`npm run audit:ui -- --bundle <2.35.1 main.js>` 核验全部保留项与新增清单通过。
- **主进程补丁核查**：确认 `dist/main.js`、`dist/menu.js`、`dist/ipcHandlers.js`、`dist/tray.js`、`dist/webviewPopupSecurity.js`、`dist/deviceChooser.js` 在 `2.35.1` 中结构完整；补充 `dist/ipcHandlers.js` 的 `Select Download Folder`（「选择下载文件夹」）原生弹窗标题补丁。
- **融合上游 `v3.3.63`–`v3.3.64` 精修**：
  - 补充内置浏览器工具栏提示 `Exit inspect element mode (Esc)` 与旁路提问引导 `Ask a side question without interrupting the main conversation`；
  - 新增 `url-security-indicator` 读屏摘要安全保留（`...。查看网站信息`）、`side-question-tab-header-name` 用户标题保护、草稿旁路提问标题 `New Side Question` 限定译名，以及按推理强度分组模型行 `model-selector-effort-group` 整行保护（防止误译模型旁 `New` 徽标）；
  - 引入 `tools/compare-plugin-catalog.js` 公开插件目录快照对比工具与对应 DOM/目录回归测试（`CodeRabbit` / `Levels.fyi` / `Zapier` 改写版本在本仓库 `official-plugin-descriptions.json` 中已提前收录）。
- **本机应用边界**：在受保护智能体会话中重新预注入最新 `v3.4.3` 补丁并生成 `app.asar.staged`（绑定 `2.35.1` 官方原版指纹）；VS Code 扩展本机未安装，macOS/Linux 仅涵盖自动化跨平台回归。
