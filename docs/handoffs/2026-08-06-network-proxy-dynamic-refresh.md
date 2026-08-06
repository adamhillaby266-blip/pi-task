# Pi Task — VPN / 系统代理动态恢复交接（2026-08-06）

## 目标与结论

解决 macOS VPN、系统 HTTP(S) 代理切换后，长期运行的 Dock LaunchAgent 仍复用旧 Undici 连接池，导致下一条模型消息卡住或出现 `fetch failed` 的问题。

本分支 `fix/network-proxy-refresh` 的改动使**新的顶层模型消息**在安全空闲窗口中采用当前网络路径；不会中断正在流式输出、压缩或执行 Bash 的 Run。

## 根因

此前 `lib/http-dispatcher.ts` 仅在服务启动时创建一次 `undici.EnvHttpProxyAgent`。同时，`lib/network-proxy.ts` 会把从 macOS `scutil --proxy` 读到的值写入 `process.env`。

因此即使之后系统代理已切换：

1. 旧 Dispatcher 仍保有旧代理连接和连接池；
2. 下次读取配置时又会把先前写入的环境变量误认为用户显式配置；
3. 进程无法重新观察当前 macOS 网络状态。

浏览器刷新无法解决此问题，因为外部模型请求由 localhost 后台 Node 服务发出。

## 实现

### 1. 纯解析，不污染进程环境

`resolveNetworkProxyConfiguration()` 保留原优先级：

1. 标准 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（大小写兼容）；
2. 权限受限的 `~/.pi-task/network.env`；
3. 当前 macOS `scutil --proxy` HTTP/HTTPS 设置；
4. 直连。

它把实际值只作为 `EnvHttpProxyAgent` 构造参数传递，并生成仅供进程内比较的 SHA-256 指纹。代理 URL、端口、凭据不会进入状态 API、日志或仓库。

### 2. 新消息前替换空闲连接池

`AgentSessionWrapper.send({ type: "prompt" })` 在调用模型前检查是否存在任何运行中的 RPC Session：

- **无活动 Run**：重新解析网络配置，替换全局 Dispatcher；即使指纹相同也新建连接，覆盖 VPN/TUN 路由变化但系统代理字段未变的情况；旧 Dispatcher 以 `close()` 优雅退出。
- **有活动 Run**：不替换 Dispatcher，确保正在流式输出的请求不被中断。
- `steer`、`follow_up` 等流内命令不触发替换。

这不读取、迁移或输出 Pi 认证、会话、Task SQLite 或代理凭据；不做外部网络探测，也不自动发送模型提示词。

## 本地验证

隔离 worktree 中完成：

- TypeScript `--noEmit` 通过；
- ESLint 通过；
- 全量 Node 测试：291 通过、0 失败；
- `git diff --check` 通过。

新增/更新的测试验证：

- macOS 系统代理切换会产生新的配置指纹，且不会把旧值写回环境变量；
- 同一代理配置下，新顶层消息仍会换用新的 Dispatcher；
- 代理端点改变后，刷新后的请求实际经过新的本地测试代理；
- RPC 只会在所有 Session 空闲时、并且在模型请求开始前刷新网络连接池。

所有测试均使用本地 HTTP 测试服务器或注入的 `scutil` 结果，不访问真实模型或外部网络。

## 待做的目标 Mac 验收

该分支尚未在目标 Mac 运行 E2/E3，也没有接触当前运行的 LaunchAgent。部署前必须：

1. 将该独立提交整合到目标 Mac 的代码目录；
2. 运行 E2 隔离构建；
3. 用户确认无活动 Run 后，运行 E3 提升并重启后台服务；
4. 在不含敏感内容的情况下，人工验证：代理/VPN 切换后，结束当前 Run 再发送下一条消息可正常返回；并验证切换过程中原有流不被中断。

E3 和真实模型请求均仍需用户明确确认。
