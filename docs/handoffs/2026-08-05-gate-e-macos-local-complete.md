# Pi Task Gate E — macOS 本机启动核心验收交接（2026-08-05）

## 当前结论

Pi Task 已在目标 Mac（Apple Silicon）完成本机源代码检出场景的核心交付：隔离生产构建通过，构建提升后可在 loopback 启动，复用既有 Pi 对话和 Task 数据；停止后可再次启动。

**这不是外部发布或完整安装包。**未做 npm/GitHub 发布、签名 `.app`、自动更新、LAN/互联网访问或 Electron/Tauri。PWA 安装到 Dock 与实际回退演练也尚未验收。

## 已通过的证据

### E2：隔离生产构建

权威运行目录：`.runtime/macos-local-build-20260805-232410/result.json`（仅含隔离数据）。

- 平台：`darwin / arm64`；Node：`v25.8.1`。
- Next 生产构建与隔离 `next start` 页面冒烟通过，`pageStatus=200`。
- 隔离认证状态为 `absent`，构建产物尚未自动提升到 `.next`。
- Runner 不下载依赖、不使用真实 `~/.pi/agent` 或 `~/.pi-task`，不发送模型提示词。

首次构建曾暴露 Webpack CSS Module 纯选择器限制：`TaskBoard.module.css` 中的裸 `button:disabled` 被拒绝。提交 `e167771` 将其限定为 `.shell button:disabled`，并加入 CSS Module 作用域回归测试；修复后 macOS E2 通过。Linux 隔离 Webpack 生产预检也返回页面 `200`，但不替代 Mac 证据。

### E3：共享数据启动

用户确认没有活动 Run 后，E3 提升了通过的 E2 产物；原 `.next`（若存在）由脚本移入 `.runtime` 备份，真实 Pi/Task 数据目录没有被复制或迁移。

macOS 人工验收确认：

1. 提升后的首次服务在 `http://127.0.0.1:30142` 正常打开；
2. 停止后再次启动仍可打开；
3. 既有 Pi 对话与 Task 都可见；
4. 系统字体栈没有明显视觉退化；
5. 验收期间没有发送模型提示词。

## 日常启动与停止

- 启动：双击 `bin/pi-task-macos.command`，或在项目根目录运行 `npm run local:mac`。
- 服务只监听 `127.0.0.1:30142`；终端需保持开启。
- 停止：在该终端按 `Control-C` 或关闭终端。
- 默认共享：Pi 数据 `~/.pi/agent`；Task 数据 `~/.pi-task/pi-task.sqlite`。不要把这些数据放进安装/构建目录。
- 备份 Task 数据前必须先停止服务；SQLite 使用 WAL，需连同 `pi-task.sqlite-wal` 和 `pi-task.sqlite-shm`（存在时）处理。

## 当前未验证与后续边界

- 在 Safari/Chrome 安装 PWA 到 Dock 后的重新打开；
- 把 E3 保存的旧 `.next` 实际回退并再次启动；
- 可分发安装包、签名、自动更新、版本升级流程、外部发布和多设备/LAN 使用。

这些不是当前本机启动通过的隐含承诺。若进入任一项，先单独确认目标平台、交付方式、数据升级/回退和验收口径。

## 相关提交

- `369dd63 feat: prepare Mac local launcher`
- `728987b feat: add isolated Mac build runner`
- `e167771 fix: scope task board disabled selector`
- `d30398b feat: promote verified Mac local builds`
