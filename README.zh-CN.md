# Pi Task

[English](./README.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md)

> 面向 Pi 开发者的本地源码任务工作区。它以 Pi 对话为中心，补足可持续的 Task、Run、产物、Review 和人工验收。

Pi Task 当前只提供开发者源码使用方式，不是面向普通用户的安装器。Gate D 的日常任务路径和 Gate E 的 macOS 本机交付路径均已有验收记录；签名应用、自动更新、托管部署和对外分发仍不在范围内。

## 已实现的能力

- 将已持久化的 Pi 对话整理为须人工确认合同的任务；
- Task 与 Run 独立于 Agent 流式状态，只有人可以验收 Review 或完成 Task；
- 支持中断、阻塞、取消、同 Session 恢复、产物和 Review 证据；
- 提供本机 Pi 会话浏览、实时对话、模型与 Skill 控制、文件预览和 Git worktree 切换。

## 使用边界

Pi Task 仅用于开发者的本机使用。

- 源码启动器只接受 loopback 主机（`127.0.0.1` 或 `localhost`）；文档中的开发与 macOS 启动路径均使用 `127.0.0.1:30142`；
- 不支持 LAN、反向代理、互联网部署、Docker 镜像、npm 发布、桌面安装器或 GitHub Release；
- 不要让 Pi Web 与 Pi Task 同时操作同一个正在执行的 Pi 会话；
- 你发送提示词后，Pi Task 可能调用本机 Pi 已配置的模型 Provider。提示词、工具结果和选定项目文件的处理应遵循该 Provider 的数据政策。

## 从源码启动

**前置条件：**Node.js 22.19.0 或更高版本。

```bash
git clone <repository-url> pi-task
cd pi-task
npm ci --include=dev --ignore-scripts
npm run dev
```

打开 <http://127.0.0.1:30142>。本仓库不是给终端用户发布的 npm 包；不要使用继承自上游的 `npx`、全局安装或 `pi-web` 命令启动 Pi Task。

隔离开发、验证命令和 macOS 构建边界见[开发者源码使用说明](./docs/development.md)。

## 本机数据与安全

| 数据 | 默认位置 | 说明 |
| --- | --- | --- |
| Pi 会话、模型设置与认证 | `~/.pi/agent` | Pi Task 会读取本机 Pi 状态；你主动使用会话管理、模型或认证操作时，相关本机数据可能被写入。 |
| Pi Task 数据 | `~/.pi-task/pi-task.sqlite` | 运行时可能同时存在 SQLite 的 WAL/SHM 文件；手工备份前应先退出 Pi Task。 |
| 项目文件 | 所选项目与会话工作目录 | 文件访问遵循本机项目/会话上下文；只应让 Agent 接触你愿意交给所配置 Provider 处理的内容。 |

做实验或测试时，将 `HOME`、`TMPDIR`、`PI_CODING_AGENT_DIR` 和 `PI_TASK_DATA_DIR` 都设在已忽略的 `.runtime/` 下。不要在 fixture 中使用真实凭据、未发布内容或公司资料。

`.gitignore` 只是防误提交措施，不是密钥管理系统。提交前检查 `git status`，不要加入 Pi 数据、SQLite、会话 JSONL、环境文件、日志或私钥。

## 开发检查

安装依赖后，在仓库根目录执行：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

日常开发不要运行 `next build` 或 `npm run build`：它会写入 `.next/`，可能干扰 `npm run dev`。macOS 的 E2 隔离构建另有流程，不等同于软件包发布。

## 文档

- [开发者源码工作流](./docs/development.md)
- [Gate D 架构与已验证范围](./docs/architecture/gate-d.md)
- [Gate E：macOS 本机交付](./docs/architecture/gate-e-macos-local.md)
- [macOS Dock/PWA 本机使用](./docs/macos-dock-pwa.md)
- [GitHub 源码首发清单](./docs/release.md)
- [Git worktree](./docs/worktrees.zh-CN.md)
- [国际化](./docs/i18n.md)

## 许可与上游来源

Pi Task 基于 [Pi Web](https://github.com/agegr/pi-web) v0.8.6 的 MIT 授权源码演进而来。上游来源和导入边界见 [UPSTREAM.md](./UPSTREAM.md)，继承的 MIT 许可声明保留在 [LICENSE](./LICENSE)。

首个公开源码仓库采用以下默认：保留当前 MIT 文本和上游署名；开启 Issues；不开 Discussions；外部 PR 需先通过 Issue 对齐范围；安全问题使用 GitHub 私密漏洞报告。仓库归属和公开快照仍在发布时确认。详见[源码首发清单](./docs/release.md)、[CONTRIBUTING.md](./CONTRIBUTING.md) 和 [SECURITY.md](./SECURITY.md)。
