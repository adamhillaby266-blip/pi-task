# Pi Task — GitHub 开源准备交接（2026-08-06）

## 给下一位执行者的结论

现在开始 **GitHub 源码仓库发布准备**，但尚未授权创建远程仓库、配置 remote、推送、公开可见、上传附件或创建 GitHub Release。先在本地完成公开前审计、文档与开发者使用路径整理；任何会把内容传出本机的动作，单独向用户确认。

本次交接开始时，代码基线为干净的 `main`，HEAD：

```text
e72102b docs: record model selection recovery acceptance
```

`git remote -v` 当前无输出，即尚未配置 GitHub remote。

## 续接时的当前状态

2026-08-06 网络兼容验收完成后，当前分支仍为干净的 `main`，HEAD 为 `5f19ec0 docs: record Mac proxy compatibility acceptance`。尚未创建 GitHub 仓库、配置 remote、推送、上传或发布。

## 产品与发布边界

- 产品名：**Pi Task**；目标仓库名：`pi-task`。
- 开源方式采用 Pi Web 式的**开发者源码使用**：Node + 终端 + 本地启动；不做 `.dmg`、签名 `.app`、Electron/Tauri、自动更新或普通用户安装器。
- 本机运行仅监听 `127.0.0.1:30142`；不开放 LAN、反向代理或互联网访问。
- 继续保留 Pi Web 的上游来源和 MIT 归属：`UPSTREAM.md` 与 `LICENSE` 不可删除或弱化。
- Pi Task 会读取用户本地 `~/.pi/agent` 及 `~/.pi-task`；公开文档必须明确数据边界、仅 loopback 的安全前提，以及不要让 Pi Web 与 Pi Task 同时操作同一个活跃会话。

## 已完成状态

### Gate D / Gate E

- Gate D（对话转 Task、同 Session 恢复、人工生命周期、合同维护与队列交互）已完成并验收。
- Gate E（macOS 本机构建、共享数据启动、Dock/PWA LaunchAgent）已完成目标 Mac 验收。
- Dock 后台服务为用户级 LaunchAgent，只监听 loopback；卸载、E3 提升、重新安装路径已在目标 Mac 实际走通。
- 实际 `.next` 回退尚未演练，不能写成“已验证”。

### 模型选择修复

提交：`5624b5e fix: surface unavailable chat model selection`

- 根因：恢复了已经删除的 `/private/tmp/pi-web-smoke-test` 测试目录；旧 UI 将模型加载失败静默处理并隐藏选择器。
- 新 UI 会保留模型入口，说明失效项目目录，并支持本机重新加载。
- 在目标 Mac 的有效本机项目目录中，当前模型和可选模型列表均正常显示。
- 本轮验收没有发送模型提示词、没有重新登录或改动认证/Task 数据。
- 详情：`docs/handoffs/2026-08-06-model-selection-recovery-complete.md`。

### 网络代理兼容

提交：`242c5aa feat: support safe local proxy configuration`、`2dbbee8 fix: define base URL in Mac service status check`

- 网络优先级为标准环境变量 → 权限受限的私有配置 `~/.pi-task/network.env` → macOS 系统 HTTP/HTTPS 代理 → 直连；不绑定 Clash、Shadowrocket 等产品。
- 目标 Mac 已在 macOS 系统代理模式下完成 E2/E3、Dock LaunchAgent、状态检查和一条用户明确授权的真实模型请求验收；HTTP 与 HTTPS 均报告为 `macos-system`，无警告。
- 不在 plist、日志、浏览器 API 或仓库中写入代理地址、端口或凭据。SOCKS/PAC-only 模式需由用户在代理软件中提供 HTTP/Mixed 或系统 HTTP/HTTPS 代理。
- 代理切换后只能在无活动 Run 时使用 `scripts/restart-macos-background-service.sh --confirm-idle` 重启服务。
- 详情：`docs/handoffs/2026-08-06-network-proxy-compatibility-complete.md`。

## 发布前必须处理的事项

按下列顺序推进；先给出审计清单和拟修改文件，再做较大范围改写。

1. **公开内容与敏感信息审计**
   - 审查受 Git 跟踪的文件、历史、示例、脚本、文档和 CI 配置是否含认证、会话、SQLite、个人目录、公司资料、屏幕截图或不应公开的绝对路径。
   - 重点验证 `.gitignore` 是否排除 `.runtime/`、`.next/`、本地 Pi/Task 数据、日志、环境文件和构建缓存。
   - 不读取或输出真实凭据；发现疑似敏感内容只报告文件路径、类型与处理建议。

2. **README 与文档边界重整**
   - 当前 `README.md` 的顶部 Pi Task 状态正确，但后半部保留了上游 Pi Web 的安装、端口 `30141`、npm 发布、LAN/代理等说明，不能原样公开。
   - 当前 `docs/release.md` 明确标注“上游 Pi Web 发布记录，不适用于 Pi Task”；需改为 Pi Task 的 GitHub 源码发布/本机构建说明，不能沿用 npm 发布命令。
   - `README.zh-CN.md`、`README.ja.md`、`README.ru.md` 及其他继承文档须盘点：更新、明确标注上游参考，或在公开前移出主入口。不要让读者误以为可以运行 `npx @agegr/pi-web`、开放 `0.0.0.0` 或安装全球 npm 包。
   - 需要补充：开发者前置条件、隔离开发方式、实际本机启动、Dock/PWA 的适用范围、数据/安全说明、已实现与未实现能力。

3. **开源仓库基础文件与许可核对**
   - 核对 `LICENSE`、`UPSTREAM.md`、`package.json` 的名称/描述/仓库链接/author/license 字段，以及 `NOTICE`、贡献说明、行为准则、安全报告渠道是否需要新增。
   - 先由用户确定仓库可见性、GitHub 组织或账户、仓库名、开源许可证的最终选择、Issue/Discussion 策略和是否接受外部 PR；没有这些决定时，提供选项，不擅自创建。

4. **可复现验证与发布材料**
   - 用隔离环境运行现有测试、类型检查、lint；常规开发不可运行 `next build`。
   - macOS 生产构建只能走已授权的 E2 隔离构建流程；不要把真实 `~/.pi` 数据放进任何 fixture、截图或仓库。
   - 最终准备一份 GitHub 首发说明（不是 GitHub Release），列出限制、已知风险、开发者启动方式和 Gate D/E 已验证范围。

## 已知资料

- 产品规则：`AGENTS.md`
- 上游归属：`UPSTREAM.md`、`LICENSE`
- Gate D：`docs/architecture/gate-d.md`
- Gate E：`docs/architecture/gate-e-macos-local.md`
- Dock 使用与代理说明：`docs/macos-dock-pwa.md`
- 模型修复验收：`docs/handoffs/2026-08-06-model-selection-recovery-complete.md`
- 网络代理验收：`docs/handoffs/2026-08-06-network-proxy-compatibility-complete.md`
- 当前代码提交序列（新到旧）：`5f19ec0`、`2dbbee8`、`242c5aa`、`a5eb28b`、`e72102b`、`5624b5e`、`26547ab`。

## 需要用户先确认的决策

在执行任何 GitHub 外部动作前，询问并记录：

1. GitHub 账户/组织、仓库名称与 public/private；
2. 是否现在创建仓库和首次推送；
3. 许可证是否沿用当前 MIT，并如何处理上游声明；
4. 是否开放 Issues、Discussions、PR；
5. 首发是否仅推源码和文档，不附二进制包、Docker 镜像、npm 包或 GitHub Release。

## 建议的 Pi Task 续接提示词

```text
读取 docs/handoffs/2026-08-06-github-publication-prep.md 后，开始为 Pi Task 做 GitHub 开源前的本地准备。先审计已跟踪内容和公开文档，列出风险、拟改文件与决策项；不要创建 GitHub 仓库、配置 remote、推送、上传或发布，直到我明确确认。保持 Pi Task 的开发者源码使用方向、仅 loopback 安全边界和上游 MIT 归属。
```
