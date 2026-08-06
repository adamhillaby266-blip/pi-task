# Gate E — macOS 本机交付

## 已确认的范围

- **受众：**一位在 Mac 上使用 Pi 的本机用户。
- **真实目标：**以明确、可停止的本机方式打开 Pi Task；浏览器/PWA 是界面入口。E4 允许用户级 `launchd` 提供后台本机服务，但不引入桌面壳、LAN 或外网访问。
- **数据决定：**复用已有 Pi 数据。默认 Pi Session、模型配置和认证仍在 `~/.pi/agent`；Task SQLite 仍在 `~/.pi-task/pi-task.sqlite`。
- **安全边界：**仅监听 `127.0.0.1`。不复制、不迁移、不上传 Pi Session、认证或 Task 数据；不自动安装依赖、不自动构建、不自动发布。
- **权威来源：**Pi Session JSONL 仍以 `~/.pi/agent` 为准；SQLite 仍以 `~/.pi-task/pi-task.sqlite` 为准；安装目录和 `.next` 只是可替换的程序文件，不能承载用户数据。

## E1 — 启动基础（当前实施范围）

1. 统一 Pi Task 的默认本机端口为 `30142`，避免开发、`npm start` 与 CLI 三套端口并存。
2. 提供 `bin/pi-task-macos.command`：双击后只启动**已验证构建**，强制 loopback，自动打开浏览器，前台运行以便用户通过关闭终端或 `Control-C` 明确停止。
3. 启动器不会设置 `HOME`、`PI_CODING_AGENT_DIR` 或 `PI_TASK_DATA_DIR`；因此默认使用已有 Pi 数据与既有 Task 数据。调用者显式设置这些变量时，启动器保留其选择。
4. 启动前检查 Node、构建产物和端口占用；不能静默构建或覆盖数据。
5. 使用系统等宽字体栈，而不是 `next/font/google`，避免本机构建时下载 Google 字体。
6. 更新产品文档，明确上游 Pi Web 发布说明不能用于 Pi Task。

### E1 成功标准

- 不带参数的 Pi Task CLI 与开发/生产脚本都使用 `30142`；显式 `PORT` 或 CLI 端口仍可覆盖。
- Mac 启动器在缺少构建、端口冲突、Node 缺失时给出可操作错误，而不创建或修改用户数据。
- 启动器代码静态检查通过；其真实启动验收留给已批准的生产构建阶段。
- 现有 D1–D3 行为、默认数据路径与 loopback 安全边界不变。

## 数据、备份与回退规则

| 内容 | 位置与处理规则 |
| --- | --- |
| Pi 对话、模型设置、认证 | `~/.pi/agent`；与现有 Pi 共用，不由 Pi Task 安装或升级程序复制、清空或迁移。 |
| Task 数据库 | `~/.pi-task/pi-task.sqlite`；SQLite 使用 WAL，手工备份或回退前必须退出 Pi Task，并同时保留 `pi-task.sqlite`、`pi-task.sqlite-wal`、`pi-task.sqlite-shm`（存在时）。 |
| 应用程序与构建产物 | 安装/发布目录及其 `.next`；可替换，不得作为数据存储位置。 |
| 日志 | E4 用户级服务写入 `~/Library/Logs/Pi Task/pi-task.log` 与 `pi-task-error.log`；前台启动时仍保留在启动终端。日志不承载 Pi 或 Task 数据。 |

## E2 — 受控生产构建与隔离页面验收（已通过）

`scripts/run-macos-local-build.sh` 把构建、Next 启动和页面冒烟都放进 `.runtime/`，不下载依赖、不接触真实数据，也不会把产物提升到默认 `.next`。

2026-08-05 的目标 Mac 运行已通过：macOS `arm64`、Node `v25.8.1`、隔离页面 `200`、`auth=absent`、`promotedToDefaultDist=false`。权威结果为 `.runtime/macos-local-build-20260805-232410/result.json`；E2 结束时产物仍在 `.runtime/macos-local-build/next`，随后才由 E3 显式提升。

2026-08-06 为模型选择修复重新执行 E2：`.runtime/macos-local-build-20260806-105849/result.json` 仍为 `darwin/arm64`、Node `v25.8.1`、页面 `200`、`auth=absent` 和未提升状态。

## E3 — 构建提升与共享数据启动（核心验收已通过）

`scripts/promote-macos-local-build.sh --confirm-idle <E2-runtime-directory>` 只接受通过的同架构 E2 结果，并且要求 Git 工作树干净、`30142` 无服务监听和操作者明确确认没有活动 Run。它会：

1. 把当前 `.next`（若有）移入带时间戳的 `.runtime` 备份；
2. 把已验证的 E2 产物提升到默认 `.next`；
3. 写入非敏感的 `promotion.json`，然后通过 `bin/pi-task-macos.command` 强制 loopback 启动；
4. 保留 `HOME`、`PI_CODING_AGENT_DIR` 和 `PI_TASK_DATA_DIR`，因此实际使用既有 `~/.pi/agent` 与 `~/.pi-task`。

2026-08-05 的目标 Mac 人工验收已通过：提升后的首次启动与随后一次 `bin/pi-task-macos.command` 重启都在 `http://127.0.0.1:30142` 成功打开；既有 Pi 对话与 Task 均可见，且系统字体栈没有明显视觉退化。验收期间没有发送模型提示词。

它不会复制、清空、迁移或备份真实 Pi/Task 数据。Dock/PWA 的重新打开已在 E4 完成人工验收；实际 `.next` 回退演练仍未执行。外部包发布、签名 `.app`、自动更新和 LAN 仍不在范围内。

## E4 — Dock/PWA 与用户级后台服务（核心人工验收已通过）

E4 的目标是让用户从 Dock 打开 Pi Task，而无需每次保留启动终端。它新增的运行时配置只在用户运行安装器后生效：

- `scripts/install-macos-background-service.sh --confirm-install` 会写入 `~/Library/LaunchAgents/com.pi-task.local.plist`，创建 `~/Library/Logs/Pi Task/`，并以当前 Node 绝对路径、`127.0.0.1:30142`、`RunAtLoad/KeepAlive` 启动 Pi Task；不需要 `sudo`，也不设置 Pi 数据目录变量。
- `scripts/status-macos-background-service.sh` 检查 LaunchAgent、本机页面和不含代理地址的网络来源；`scripts/restart-macos-background-service.sh --confirm-idle` 可在切换代理后重启空闲服务；`scripts/uninstall-macos-background-service.sh --confirm-remove` 只移除该服务配置，保留 Pi 数据、Task 数据、构建和日志。
- 服务进程优先使用标准 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，其次是权限受限的 `~/.pi-task/network.env`，再读取 macOS 当前 HTTP/HTTPS 系统代理；不会把代理值写入 plist、日志或浏览器 API。服务启动时和每条新的顶层模型消息发送前都会重新解析当前配置；仅在没有活动 Run 时替换连接池，因此切换 VPN/代理后下一条新消息可自动采用新路径，而流式输出不会被强行中断。SOCKS/PAC-only 配置需要用户在代理工具中启用 HTTP/Mixed 或系统 HTTP/HTTPS 代理。
- Safari/Chrome 的“添加到 Dock / 安装 Pi Task”仍需用户手势完成；PWA 只作为界面，后台服务负责本机页面可用性。

2026-08-06，目标 Mac 用户按安装、状态检查和 Dock 打开清单完成操作后确认“可以了，没问题”。这确认了日常入口：用户级服务可用，关闭原启动终端后可从 Dock 打开 Pi Task，既有对话/Task 保持可见；验收未报告模型提示词。

2026-08-06 的模型选择修复（`5624b5e`）已通过新的 E2/E3 和目标 Mac 人工验收：旧的临时测试会话目录不存在时，界面明确提示并保留“没有可用模型／重新加载模型”入口；切换到一个存在的本机项目目录后，当前模型和可选模型列表均可恢复显示。验收未发送模型提示词。

本次更新已实际执行卸载器、E3 提升和重新安装后台服务；用户随后确认 Dock 入口正常。卸载器只移除了 LaunchAgent 配置并成功恢复服务，未报告 Pi/Task 数据异常。实际 `.next` 回退演练仍保留为后续可逆验证。

2026-08-06 的通用代理解析逻辑已通过目标 Mac 验收：E2 `.runtime/macos-local-build-20260806-181829/result.json` 为 `darwin/arm64`、页面 `200`、`auth=absent`；E3 提升后，`/api/network/status` 返回 HTTP/HTTPS 均为 `macos-system`、无警告。重新安装 LaunchAgent 后，状态脚本返回页面 `HTTP 200` 及相同代理来源；用户从 Dock 发起无敏感内容的真实模型测试并确认成功。该次模型请求是为网络验收明确授权的唯一真实调用。

## 明确不做

- 不做 Electron、Tauri、签名 `.app`、自动更新；
- 不开放 `0.0.0.0`、LAN、反向代理或互联网访问；
- 不改变 `~/.pi/agent` 与 `~/.pi-task` 的默认路径；
- 不发布 npm 包、GitHub Release，或重跑真实模型。
