# Pi Task — 通用网络代理兼容与本机修复交接（2026-08-06）

## 当前结论

Pi Task Dock 后台服务的模型网络连接已恢复，并已实现面向后续 GitHub 开源用户的通用代理逻辑。实现不识别或绑定 Clash、Shadowrocket 等具体产品，而是遵循标准 HTTP(S) 代理与 macOS 系统代理。

相关提交：

```text
242c5aa feat: support safe local proxy configuration
2dbbee8 fix: define base URL in Mac service status check
```

## 原问题与根因

模型列表能显示且 `GPT-5.6 Terra` 已被选中，但实际消息返回 `Error: fetch failed`。Pi Web 同一台 Mac 可正常调用，说明 Provider 认证和外部代理本身不是全局失效。

诊断确认：Dock LaunchAgent 没有 `HTTP_PROXY`、`HTTPS_PROXY` 等环境变量，而用户需要 Clash 或 Shadowrocket 代理访问模型。原服务没有读取 macOS 系统代理，因此后台进程无法可靠获得出网路径。

## 实现方案

`lib/network-proxy.ts` 在 Node HTTP dispatcher 初始化前解析以下来源，优先级为：

1. 标准 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（大小写兼容）；
2. 仅当前用户可读的私有本机文件 `~/.pi-task/network.env`（建议权限为 `600`）；
3. macOS `scutil --proxy` 的当前 HTTP/HTTPS 系统代理；
4. 直连。

安全约束：

- 代理 URL 不写入 LaunchAgent plist、日志、浏览器 API、测试输出或仓库；
- 私有文件只解析三项允许变量，绝不 `source` 或执行 shell 内容；
- 组/其他用户可读、格式错误、SOCKS-only 或 PAC-only 配置均给出不含端点的状态/警告；
- 有代理时默认将 `localhost,127.0.0.1,::1` 加入 `NO_PROXY`；
- `/api/network/status` 只返回来源、启用状态和警告，不返回地址、端口或凭据；
- 切换代理后必须确认无活动 Run，再使用 `scripts/restart-macos-background-service.sh --confirm-idle` 重启后台服务。

私有配置文件只用于代理软件未启用 macOS 系统 HTTP/HTTPS 代理、但提供 HTTP/Mixed 端口的场景。详情见 `docs/macos-dock-pwa.md`。

## 验证

### 本地工程验证

- 288 项 Node 测试通过；
- TypeScript `--noEmit`、ESLint、shell 语法和 `git diff --check` 通过；
- 单测覆盖 macOS HTTP/HTTPS 代理解析、环境优先级、私有配置权限、SOCKS/PAC 提示、无端点泄露及状态脚本的 `nounset` 回归。

### 目标 Mac 验收

1. E2：`.runtime/macos-local-build-20260806-181829/result.json`，`darwin/arm64`、Node `v25.8.1`、页面 `200`、`auth=absent`、未自动提升；
2. E3 前台服务的 `/api/network/status` 返回：HTTP/HTTPS 均为 `macos-system`，已启用，无警告；私有配置为 `missing`，即未读取任何用户代理地址；
3. 重新安装 LaunchAgent 后，`scripts/status-macos-background-service.sh` 返回页面 `HTTP 200`，并显示“HTTP macOS 系统代理；HTTPS macOS 系统代理”；
4. 用户从 Dock 发起无敏感内容的真实模型测试后回复“ok了”。这是用户明确授权的实际调用；未重新登录、未迁移 Pi/Task 数据。

## 修复中发现的脚本问题

首次状态检查在页面 `HTTP 200` 后因 `base_url` 未定义而停止；这只影响网络来源显示，不影响服务或数据。`2dbbee8` 已修复，并加入 `scripts/status-macos-background-service.test.mjs`，以 `bash -u` 模拟 macOS LaunchAgent 状态检查防止回归。

## 未完成与日常规则

- E3 旧 `.next` 的实际回退仍未演练。
- 同一时间只应让一个代理工具接管 macOS 系统代理。
- Pi Web 与 Pi Task 不应同时操作同一个活跃会话。
- GitHub 仍未创建 remote、推送或发布；开源准备交接见 `docs/handoffs/2026-08-06-github-publication-prep.md`。
