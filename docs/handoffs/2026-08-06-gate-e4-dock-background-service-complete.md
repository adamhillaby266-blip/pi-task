# Pi Task Gate E4 — Dock/PWA 与本机后台服务交接（2026-08-06）

## 当前结论

Pi Task 的日常 Mac 入口已完成：当前用户的 LaunchAgent 提供仅 loopback 的本机服务，Pi Task 已可从 Dock/PWA 打开，无需保留启动终端。

这是开发者源码检出场景下的个人本机使用方式，不是签名 `.app`、安装包、自动更新或网络服务。

## 目标 Mac 人工验收

用户按安装、状态检查、Safari 加入 Dock、关闭原启动终端并从 Dock 重开 Pi Task 的清单完成操作后，回复“可以了，没问题”。据此确认：

- 服务可作为日常本机入口使用；
- Dock/PWA 可重新打开 Pi Task；
- 既有 Pi 对话和 Task 在该入口中可见；
- 验收未报告模型提示词发送或视觉/数据异常。

该确认是人工验收记录；未额外保存或读取用户的 Pi 认证、会话或 SQLite 数据。

## 实现与边界

提交：`6254736 feat: add Mac Dock background service`

- 安装：`scripts/install-macos-background-service.sh --confirm-install`
  - 只写入 `~/Library/LaunchAgents/com.pi-task.local.plist` 和 `~/Library/Logs/Pi Task/`；无需 `sudo`。
  - 仅启动 `127.0.0.1:30142`，设置 `RunAtLoad` 与 `KeepAlive`。
  - 不设置或迁移 `HOME`、`PI_CODING_AGENT_DIR`、`PI_TASK_DATA_DIR`，因此仍复用 `~/.pi/agent` 与 `~/.pi-task`。
- 状态：`scripts/status-macos-background-service.sh`
- 移除：`scripts/uninstall-macos-background-service.sh --confirm-remove`
  - 只移除本服务配置；不会删除 Pi 数据、Task 数据、构建或日志。
- PWA service worker 缓存前缀已从 `pi-web` 改为 `pi-task`，避免与上游 Pi Web 混用。
- `bin/pi-web.js` 会在 `SIGINT`/`SIGTERM` 时转发信号给 Next 子进程，支持 launchd 正常停止。

日常规则不变：不要让 Pi Web 与 Pi Task 同时操作同一个正在执行的会话。

## 已验证的工程检查

在提交前完成：

- LaunchAgent 模板单测通过；
- 210 项 Node 测试通过；
- ESLint、shell 语法、Node 语法与 `git diff --check` 通过；
- 隔离生产 Next 服务验证了页面、manifest 和 service worker 均返回 `200`；
- 移除 Next E2 staging 后遗留的 `types` 目录后，隔离 `next start` 仍返回 `200`。

此前 E3 将隔离构建提升到 `.next` 时，Next 的纯类型生成文件保留了 staging 相对路径。E4 安装器及后续 E3 提升会仅清理这些不参与运行的 `.next/types` 文件，不接触应用运行文件或用户数据。

## 尚未演练的可逆路径

为保留已确认可用的日常服务，以下项目未在目标 Mac 实操：

1. 运行卸载器后验证 LaunchAgent 移除；
2. 把 E3 备份的 `.next` 实际回退并重新启动。

这两项不阻塞当前使用，但未来升级、Node 路径变动或发布前审计时应单独执行。若 Node.js 被升级或移动，先运行卸载器，再重新安装服务。

## 相关资料

- 架构和范围：[Gate E — macOS 本机交付](../architecture/gate-e-macos-local.md)
- 日常说明：[Pi Task：加入 Dock 的本机使用方式](../macos-dock-pwa.md)
- 上一阶段：[Gate E 核心本机启动交接](./2026-08-05-gate-e-macos-local-complete.md)
