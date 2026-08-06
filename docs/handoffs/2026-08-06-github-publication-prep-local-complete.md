# Pi Task — GitHub 开源本地准备完成（2026-08-06）

## 当前结论

GitHub 开源的**本地准备**已完成；没有创建 GitHub 仓库、添加 remote、推送、上传附件或创建 GitHub Release。下一步必须由维护者明确确认账户/组织、仓库名、可见性和首次推送范围后再执行任何外部动作。

本轮开始时为干净的 `main`，HEAD 为 `a4b16ce`；当前改动尚未提交，方便维护者先审阅。

## 已完成

### 公开内容与敏感信息审计

- 对当前已跟踪内容和 39 个可达提交做了高置信度密钥、Token、Bearer、带凭据 URL 扫描；未发现匹配项。扫描结果不等同于对未知格式秘密的绝对保证。
- 当前工作树中已清理真实工作区路径；测试代码中的 `alex`、`me`、`example` 路径均为泛化 fixture，未改动。
- `.gitignore` 已补充项目检出内误放的 `.pi/`、`.pi-task/`、SQLite/WAL、DB、JSONL、通用日志、`.key`、`.p12`、`.pfx` 以及常见构建缓存的保护。
- 已修复继承的非 loopback 启动缺口：源码启动器拒绝非 loopback 的 CLI/环境变量 hostname，API Host 校验仅接受 loopback，Next 开发配置不再允许 LAN origin；对应 16 项启动/请求安全测试通过。
- 已视觉检查继承的 `docs/screenshot2.png`：它是 Pi Web 演示图，含上游界面和浏览器头像。README 已取消引用；是否从公开快照中保留该文件仍需维护者决定。

### README、发布与源码使用说明

- 四种 README 均改为 Pi Task 的开发者源码使用说明，移除了上游 Pi Web 的 `npx`、全局安装、30141、LAN 和 npm 发布指引。
- 新增 `docs/development.md`：前置条件、隔离 runtime、数据边界、验证命令、macOS E2/E3 边界和提交前检查。
- `docs/release.md` 改为 GitHub 源码首发清单，明确它不是 npm/GitHub Release 流程，并列出外部动作授权门。
- 更新 worktree、i18n、Dock/PWA 和相关验收文档中的产品名及本地路径示例。
- `LICENSE`、`UPSTREAM.md` 和 `package.json` 未擅自改动：许可证权属、作者字段、仓库 URL 均待维护者决定。

## 验证

所有命令在 `.runtime/github-publication-validation-20260806/` 的隔离 `HOME`、临时目录、Pi 目录和 Task 数据目录下执行；未运行 `next build`。

- `node_modules/.bin/tsc --noEmit`：通过；
- `npm run lint`：通过；
- 常规 Node 测试：222 通过，1 个 `clean projects stay on the normal trusted load path` 在本工作区因父级 `.agents/skills` 注入 fixture 而失败；这是已知的环境限制，不是本轮文档改动导致；
- 对应的 4 个 workspace-compatible project-trust 用例：全部通过；
- Markdown 本地链接、代码围栏与 `git diff --check`：通过；
- 修改后高置信度秘密扫描：当前树与可达历史均为 0 匹配；
- 启动与请求安全针对性测试：16 项通过。

Node 将部分未声明模块类型的 `.ts` 测试文件重新解析为 ESM，并打印性能警告；测试仍正常完成。这是现有仓库配置事项，未在本轮为开源准备擅自改动。

## 已确认的首发策略

- 仓库名：`pi-task`；可见性：`public`；
- 推送范围：新的干净源码快照，不公开现有 39 个本地提交及其直接作者邮箱；
- 许可证：保留现有 MIT 文本与 `UPSTREAM.md` 的上游归属；
- 首发内容：仅源码和文档，不含二进制、Docker、npm 包或 GitHub Release；
- 社区：开启 Issues；不开 Discussions；外部 PR 先通过 Issue 对齐范围；
- 安全：使用 GitHub Private Vulnerability Reporting，并提供 `SECURITY.md`；
- 截图：本机原件保留，但从公开快照排除；
- 启动安全：非 loopback CLI/API 缺口已修复并验证。

已在忽略的 `.runtime/github-public-source-snapshot/` 生成一个 300 文件、零提交的本地公开快照：包含本轮文档和安全修复，不含 `docs/screenshot2.png`，也不含原仓库 Git 历史。快照的暂存区与高置信度秘密扫描已通过。

## 外部动作前仅剩的信息

GitHub CLI 当前未登录。维护者只需提供或通过浏览器登录确认其 GitHub **用户名/组织名**；不需要在聊天中提供密码或 Token。随后以 GitHub noreply 邮箱创建快照首个提交，创建 public `pi-task` 仓库、启用私密漏洞报告并推送。
