# Pi Task：加入 Dock 的本机使用方式

> 仅适用于已经完成本机构建与首次启动验收的 Mac。它不开放网络访问，服务只监听 `127.0.0.1:30142`。

## 一次性安装后台服务

先确认当前没有通过终端运行的 Pi Task，再在项目根目录执行：

```bash
./scripts/install-macos-background-service.sh --confirm-install
```

安装器会创建当前用户的 LaunchAgent 和日志目录，不需要管理员密码。它不会复制、删除或迁移：

- Pi 对话、模型设置与认证：`~/.pi/agent`
- Task 数据：`~/.pi-task`

成功后可检查：

```bash
./scripts/status-macos-background-service.sh
```

预期页面状态为 `HTTP 200`。

## 升级已安装的后台服务

需要升级源码时，双击 Finder 中的 `bin/upgrade-pi-task-macos.command`，确认当前没有活动 Run 后输入 `UPGRADE`。它会：先进行隔离构建和页面冒烟，再短暂停止后台服务、提升已验证构建、恢复原有 LaunchAgent；若新构建无法启动，会尝试恢复上一份 `.next`。全过程不复制、删除或迁移 Pi 对话、认证或 Task 数据，也不会发送模型提示词。

也可在终端运行：

```bash
./scripts/upgrade-macos-background-service.sh --confirm-idle
```

## 加入 Dock

后台服务已正常运行后，任选一个浏览器完成一次：

- **Safari：**打开 `http://127.0.0.1:30142`，选择“文件 → 添加到程序坞”。
- **Chrome：**打开同一地址，使用地址栏的安装图标或浏览器菜单中的“安装 Pi Task”。

安装后从 Dock 打开的 Pi Task 是独立窗口；日常无需启动终端。

## 日常使用

1. 从 Dock 打开 Pi Task；
2. 正常处理对话、任务和验收；
3. 后台服务会在本机登录后保持可用。

不要同时用 Pi Web 和 Pi Task 对同一个正在执行的对话发消息。

## 恢复到已删除项目的旧对话

若输入框上方提示“这段对话原来的项目文件夹已不存在”，这是旧对话保存的工作目录已被删除，不是登录失效。不要重新登录或新增 Provider：

1. 点击左上角当前项目路径；
2. 选择“自定义路径”；
3. 选择一个存在的项目目录，例如 `~/Projects/example-project`；
4. 等待模型名称出现在输入框下方，必要时点“重新加载模型”。

模型入口会保留并显示原因；切换到有效目录后可正常选择模型。

## 网络与代理

Pi Task 不识别 Clash、Shadowrocket、Surge 等具体软件；它使用通用的 HTTP(S) 代理规则，优先级如下：

1. 进程已设置的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（大小写形式均可）；
2. 私有本机配置 `~/.pi-task/network.env`；
3. macOS 当前启用的系统 HTTP/HTTPS 代理；
4. 直连。

后台服务启动时、以及每条新的顶层模型消息发送前都会读取当前配置，不会把代理地址、端口或凭据写入 LaunchAgent、日志、浏览器接口或仓库。同一时间只应让一个代理工具接管系统代理。

切换 Clash、Shadowrocket、VPN 或系统代理时，正在流式输出的 Run 不会被强行中断；等它结束后，下一条新消息会自动建立新连接并使用当前网络路径，通常不再需要手动重启服务。若旧版本仍在运行、或某条请求已卡住，可在确认没有活动 Run 后使用：

```bash
./scripts/restart-macos-background-service.sh --confirm-idle
./scripts/status-macos-background-service.sh
```

状态脚本只显示“标准环境变量／本机私有配置／macOS 系统代理／直连”等来源，不显示代理地址或凭据。

若代理工具没有启用 macOS 系统 HTTP/HTTPS 代理，但提供 HTTP 或 Mixed 端口，可创建仅当前用户可读的私有配置文件（建议权限为 `600`）：

```bash
mkdir -p ~/.pi-task
umask 077
cat > ~/.pi-task/network.env <<'EOF'
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1
EOF
chmod 600 ~/.pi-task/network.env
```

其中端口 `7890` 只是示例，使用代理工具实际提供的 HTTP/Mixed 端口。该文件只接受上述三项变量，作为数据解析而不会被 shell 执行；不要提交、截图或通过聊天发送含认证信息的代理 URL。

TUN 模式通常无需配置；仅 SOCKS 或 PAC 模式不会被自动转换，应在代理工具中启用 HTTP/Mixed 或系统 HTTP/HTTPS 代理后再重启服务。

## 检查、停止与移除

- 检查服务：`./scripts/status-macos-background-service.sh`
- 查看日志：`~/Library/Logs/Pi Task/pi-task.log` 与 `pi-task-error.log`
- 移除后台服务：

  ```bash
  ./scripts/uninstall-macos-background-service.sh --confirm-remove
  ```

移除服务不会删除 Pi 对话、认证、Task 数据、构建产物或日志。若要再次使用终端前台启动，可双击 `bin/pi-task-macos.command`。

如果之后升级或移动了 Node.js，LaunchAgent 保存的 Node 路径可能失效：先移除服务，再重新运行安装器；数据不会受影响。
