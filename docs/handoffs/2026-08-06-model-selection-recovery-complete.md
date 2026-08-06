# Pi Task — 模型选择与失效项目目录恢复交接（2026-08-06）

## 当前结论

Pi Task 的模型选择入口已恢复并完成目标 Mac 验收。问题不是 ChatGPT 登录或后台服务丢失数据，而是 PWA 恢复了一个工作目录已删除的旧测试会话；旧界面把模型加载失败静默处理，导致模型控件消失。

修复提交：`5624b5e fix: surface unavailable chat model selection`

## 根因与修复

用户截图显示旧会话的工作目录为 `/private/tmp/pi-web-smoke-test`，文件浏览器显示 `Not found`。模型接口因目录不存在返回 `400`，但此前 `useAgentSession` 忽略了非 `200` 响应；`ChatInput` 又只在存在模型列表、当前模型或运行时错误时渲染选择器。

修复内容：

- `/api/models` 为失效目录、非目录、访问拒绝和运行时加载失败返回无敏感错误码；不再静默伪装成空模型列表。
- 输入框下方始终保留模型入口；失效项目目录会显示明确中文提示，并提供“重新加载模型”。
- 手动重新加载只使 Pi 的本机模型快照绕过短缓存，不发送提示词、不调用模型、也不变更认证。
- 新请求覆盖旧请求的加载状态，避免切换项目后旧响应覆盖新列表。

## 验收证据

### 工程与隔离验收

- 267 项 Node 测试、TypeScript `--noEmit`、ESLint 和 diff 检查均通过。
- 隔离 API 冒烟确认：失效 cwd 返回 `400 / cwd_unavailable`；有效 cwd 返回模型数组；使用隔离的虚拟 ChatGPT OAuth 凭据时，API 返回 7 个 `openai-codex` 模型，无网络或模型提示词。
- 目标 Mac E2：`.runtime/macos-local-build-20260806-105849/result.json`，`darwin/arm64`、Node `v25.8.1`、页面 `200`、`auth=absent`、未自动提升。

### 目标 Mac 人工验收

1. E3 提升后，旧测试目录显示“暂时无法选择模型”及“原项目文件夹已不存在”的明确说明，模型入口仍可打开；
2. 用户将当前目录切换为一个存在的本机项目目录；
3. 输入框下方恢复显示当前模型；
4. 下拉列表恢复显示该本机配置可用的模型；
5. 未发送模型提示词；
6. 用户停止前台验收进程后重新安装 LaunchAgent，并确认 Dock 入口正常。

## 数据与运行边界

- 本次没有重新登录、添加 Provider、复制或迁移 `~/.pi/agent`、`~/.pi-task`。
- 更新过程实际执行过 `uninstall-macos-background-service.sh --confirm-remove`、E3 提升和重新安装；LaunchAgent 的移除与恢复路径均已在目标 Mac 上走通。
- 仍未演练：把 E3 备份的旧 `.next` 实际回退后再启动。
- 日常仍不要让 Pi Web 与 Pi Task 并发操作同一个正在执行的会话。

## 用户操作提示

若未来再次恢复到已删除目录的旧会话：点击左上项目路径 → “自定义路径” → 选择存在的项目目录；模型会重新加载，无需重新登录。详见 [Pi Task：加入 Dock 的本机使用方式](../macos-dock-pwa.md)。
