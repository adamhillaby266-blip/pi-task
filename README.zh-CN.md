# Pi Task

[English](./README.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md)

> **把一段 AI 对话，变成可以恢复、审查和验收的工作。**

Pi Task 是一个基于 [Pi](https://github.com/badlogic/pi-mono) 的本地对话式任务工作台。选择一个工作目录，先自然交流；只有当事情值得持续交付时，再把它整理成包含目标、执行记录、验证证据和人工验收的正式任务。

**对话优先 · 单一工作目录 · 人工掌握关键决定 · 本地源码运行**

![Pi Task 将对话整理为可以审查的任务约定](./docs/assets/pi-task-task-framing.png)

*画面来自完全隔离的虚构工作区，不包含真实 Session、Task、凭据或本机路径。*

## 为什么需要 Pi Task

聊天记录可以解释“说过什么”，但有交付要求的工作还需要回答：

- 最终到底要交付什么？
- 哪些资料和约束才是权威依据？
- 当前是中断、阻塞，还是在等待人的决定？
- 实际改了什么、如何验证，还有什么尚未确认？
- 最后由谁判断这项工作真的完成？

Pi Task 把这些答案留在原来的 Pi 对话中，不要求用户先转到另一套项目管理系统。

```text
选择一个工作目录
→ 自然对话
→ 值得持续交付时，保存或确认任务约定
→ 在同一对话中执行、暂停、回答决定或恢复
→ 检查产物和验证证据
→ 接受交付，或退回继续处理
```

简单问题仍然只是简单对话。只有需要持续交付时，才使用 Task。

## 它有什么不同

- **一个工作目录贯穿始终：**对话、文件、实际加载的规则来源和 Task Board 使用同一工作范围。
- **任务从对话中自然形成：**开始思考前，不需要先创建 Project，也不需要填写冗长任务表单。
- **关键确认不会被界面绕过：**点击一个决定选项只是回答问题，不会静默启动 Run，也不会自动授权外部操作。
- **Task 和 Run 相互独立：**Agent 输出结束不等于业务完成；只有人可以接受 Review 或完成 Task。
- **工作可以中断后继续：**中断、阻塞、取消、同 Session 恢复、产物和 Review 证据都会保留。
- **Pi 对话仍是中心：**会话浏览、实时聊天、模型、Skill、文件和 Git worktree 能力继续围绕任务流程使用。

## 从源码开始

**前置条件：**Node.js 22.19.0 或更高版本。

```bash
git clone https://github.com/adamhillaby266-blip/pi-task.git
cd pi-task
npm ci --include=dev --ignore-scripts
npm run dev
```

打开 <http://127.0.0.1:30142>。

Pi Task 当前是开发者源码版本，不是普通用户安装器或 npm 包。不要使用继承自上游的 `npx`、全局安装或 `pi-web` 命令启动。隔离开发、验证命令和 macOS 本机构建路径见[开发者源码使用说明](./docs/development.md)。

## 当前使用边界

Pi Task 面向开发者本机使用。

- 源码启动器只接受 loopback 主机（`127.0.0.1` 或 `localhost`）；
- 不支持 LAN、反向代理、托管部署、Docker 镜像、npm 发布、签名桌面安装器、自动更新或 GitHub Release；
- 不要让 Pi Web 与 Pi Task 同时操作同一个正在执行的 Pi Session；
- 当前不会默认开启多 Agent；产品主路径仍是一段对话和明确的人工决定。

## 本机数据与模型隐私

应用与任务状态保存在本机，但模型请求仍遵循 Pi 中配置的 Provider。

| 数据 | 默认位置 | 说明 |
| --- | --- | --- |
| Pi 会话、模型设置与认证 | `~/.pi/agent` | Pi Task 会读取本机 Pi 状态；你主动执行的操作可能更新这些数据。 |
| Pi Task 数据 | `~/.pi-task/pi-task.sqlite` | Task、Run、产物、Review 和事件记录保存在本机 SQLite 中；手工备份前应先退出 Pi Task。 |
| 工作目录文件 | 当前工作目录与恢复的 Session 目录 | 提示词和工具操作可能把选定内容交给所配置的模型 Provider；请遵循该 Provider 的数据政策。 |

做实验或测试时，将 `HOME`、`TMPDIR`、`PI_CODING_AGENT_DIR` 和 `PI_TASK_DATA_DIR` 都放在已忽略的 `.runtime/` 下。不要在 fixture 中使用真实凭据、未发布内容或公司资料。

`.gitignore` 只是防误提交措施，不是密钥管理系统。提交前检查 `git status`，不要加入 Pi 数据、SQLite、会话 JSONL、环境文件、日志或私钥。

## 开发检查

安装依赖后执行：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

日常开发不要运行 `next build` 或 `npm run build`：它会写入 `.next/`，可能干扰 `npm run dev`。macOS 隔离构建另有流程，不等同于软件包发布。

## 文档

- [产品主线与边界](./docs/product/pi-task-product-boundary.md)
- [从对话形成任务](./docs/architecture/task-framing.md)
- [开发者源码工作流](./docs/development.md)
- [Task 与 Run 架构](./docs/architecture/gate-d.md)
- [macOS 本机交付](./docs/architecture/gate-e-macos-local.md)
- [macOS Dock/PWA 本机使用](./docs/macos-dock-pwa.md)
- [Git worktree](./docs/worktrees.zh-CN.md)
- [参与贡献](./CONTRIBUTING.md) · [安全报告](./SECURITY.md)

## 许可与上游来源

Pi Task 基于 [Pi Web](https://github.com/agegr/pi-web) v0.8.6 的 MIT 授权源码演进而来。上游来源和导入边界见 [UPSTREAM.md](./UPSTREAM.md)，继承的 MIT 许可声明保留在 [LICENSE](./LICENSE)。

仓库已开启 Issues，未开启 Discussions。聚焦的 Pull Request 应先通过 Issue 对齐范围；安全问题请使用 GitHub Private Vulnerability Reporting。
