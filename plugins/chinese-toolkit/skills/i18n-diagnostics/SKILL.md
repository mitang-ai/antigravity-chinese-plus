---
name: i18n-diagnostics
description: 检查 Antigravity 汉化状态、打开中文汉化守护驾驶舱、适配上游更新、诊断漏翻或在线更新版本时使用。
---

# 本地化维护与中文守护

## 1. 优先打开「中文汉化守护」侧边栏驾驶舱

若用户询问当前汉化状态、客户端官方更新后恢复旧版翻译、检查汉化新版或在插件内一键在线更新并重启，直接在回复中提供侧边栏驾驶舱打开入口（需确认插件已启用）：

```markdown
[打开中文汉化守护](sidecar://chinese-toolkit/i18n_guardian/)
```

驾驶舱核心能力：
- **跨官方更新保留旧版翻译**：外置运行中心位于 `~/.gemini/antigravity-chinese-plus/runtime/`，官方更新覆盖 `app.asar` 时自动识别并用已有词库预构建兼容 `app.asar.staged`。
- **在线检测与一键更新**：联网检测 `mitang-ai/antigravity-chinese-plus` 最新 Release，支持可选加速镜像，一键下载更新并自动弹出重启请求框。
- **优雅重启切换**：用户确认重启后安全请求主窗口退出并在 0.5 秒内完成原子替换后重开中文客户端。

## 2. 本地维护与诊断

定位 `antigravity-chinese-plus` 仓库后可执行：
- `node cli.js status`：检查桌面客户端、`app.asar.staged` 指纹与实时缓存状态。
- `node cli.js sync-guardian`：同步本地词库与引擎至持久化外置运行中心并安装启用插件。
- `node cli.js create-shortcut`：在桌面创建「Antigravity 中文自愈版」启动入口。
- `npm run audit:ui -- --bundle <官方前端-main.js>`：核对实包组件清单与文案映射。
- `npm test` 与 `npm run audit`：全量回归与一致性门禁验证。
