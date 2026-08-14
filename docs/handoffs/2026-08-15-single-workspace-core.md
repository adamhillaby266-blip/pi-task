# 单一工作目录与对话式任务入口：隔离实现完成

> 状态：已在独立分支完成实现、自动测试、macOS arm64 隔离生产构建和虚构真实页面验收；尚未合入 `main`、安装到真实服务或推送公开仓库。
>
> 基线：`main@c87446d`
>
> 分支：`feat/single-workspace-core`
>
> 实现提交：`19d7a47 feat(workspace): center tasks on the working directory`
>
> 升级防护提交：`d61acb1 fix(upgrade): refuse stale installed dependencies`
>
> 阻塞选项交互修复：`cb5226f fix(task): make framing decision options actionable`

## 1. 本轮产品边界

用户侧只保留一处“当前工作目录”。对话、文件和 Task Board 跟随这处目录；Project 选择、新建 Project、新任务表单和自由对话顶部的旧“直接填写”入口退出主界面。

内部 `projects` 表、稳定 ID、历史 Task、Run、Review、Session 绑定和交付物范围校验保持不变，没有数据库迁移。历史 Task 的旧字段编辑仍保留为明确标注的兼容回退，不作为新任务入口。

本轮没有加入规则编辑器、同步、通用备份、文件并发、团队权限或默认多 Agent。

## 2. 关键实现

- 左侧显示目录名、完整路径和 SDK 实际加载的规则来源；只返回路径与个人／当前／上级范围，不返回规则正文，并明确规则不是操作系统沙箱。
- Task Board 自动选择当前目录下最具体的兼容内部 Project；没有匹配时显示空状态和“开始聊一个任务”。
- 看板只负责查看、推进、恢复和验收；“开始聊一个任务”回到同一工作目录的新对话，不提前创建 Task。
- Task Framing 候选卡显示工作范围。用户保存或确认时，才按需登记内部目录映射并提交正式 Task。
- 可写对话注入简短通用工作纪律；关闭写入工具时不注入，Task Framing 工具启用时继续叠加原有候选约定提示。
- `run-macos-local-build.sh` 在构建和停服前运行 `npm ls --depth=0`；依赖与 `package.json` 不一致时终止，且不会自行安装或下载。
- 产品边界记录：`docs/product/pi-task-product-boundary.md`。

## 3. 自动验证

最终使用与锁文件一致的既有隔离依赖：Pi SDK `0.84.1`、Undici `8.9.0`；本轮没有安装新依赖。

- TypeScript：通过；
- ESLint：通过；
- `bash -n scripts/run-macos-local-build.sh`：通过；
- `git diff --check`：通过；
- 常规测试：`360/360`；
- 工作区兼容 Project Trust：`4/4`；
- macOS arm64 隔离生产构建：HTTP 200、无认证、未提升到 `.next`。

生产构建记录：

- `.runtime/macos-local-build-20260815-015351/result.json`
- `.runtime/single-workspace-e2-correct-deps.log`

仍只有既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告，没有新增测试失败。

## 4. 虚构真实页面验收

隔离运行目录：

- `.runtime/single-workspace-production-correct-deps-20260815-020302/`

### 4.1 已有历史任务目录

`single-workspace-browser-result.json` 记录：

- 页面、规则接口和 Task 接口均为 200；
- 当前目录读取到 4 个历史 Task；
- 界面无 Project 选择、新建 Project、新任务表单或内部 Project 名；
- “开始聊一个任务”回到相同目录的新对话，点击前后 Task 均为 4；
- 已持久普通对话显示“一起把任务聊清楚”；
- 规则区显示 5 个实际来源和通用纪律，不显示虚构规则正文，`systemSandbox=false`；
- 390px 页面无 body 横向溢出；
- 浏览器未记录 console error。

主要截图：

- `single-workspace-rules-wide.png`
- `single-workspace-task-board-wide.png`
- `single-workspace-task-board-narrow.png`
- `single-workspace-new-task-conversation.png`
- `single-workspace-conversation-framing-affordance.png`

### 4.2 从未登记内部 Project 的目录

`unregistered-workspace-confirm-result.json` 记录：

- 用户确认前：Project=1、Task=4，当前 Session 的 `task=null`、`project=null`；
- Task Board 显示“这里还没有正式任务”，没有 Project 控件；
- 候选卡显示当前工作范围，390px 无 body 横向溢出；
- 用户明确点击“确认并放入待办”后：Project=2、Task=5；
- 新 Task 为 `ready`、`activeRunId=null`、Run=0；
- 新内部 Project 的 `rootPath` 与当前工作目录完全一致；
- operation 状态为 `confirmed`，没有自动开始；
- 浏览器未记录 console error。

主要截图：

- `unregistered-candidate-before-confirm-wide.png`
- `unregistered-candidate-before-confirm-narrow.png`
- `unregistered-workspace-empty-board.png`
- `unregistered-candidate-after-confirm-wide.png`

验收后 `31436` 隔离服务和 `9225` 隔离 Chrome 均已关闭；真实 `30142` 服务保持 HTTP 200。

## 5. 阻塞决定选项交互修复

用户复核真实任务约定卡后指出：阻塞决定的选项视觉上类似按钮，但实现只是静态列表，无法进入下一步。该问题已在同一隔离分支修复：

- `options` 使用原生 `button`，支持鼠标、hover、焦点与 Enter 键；
- 点击经现有 ChatInput `sendIfEmpty` 发送一条可见用户消息，请 Agent 更新候选约定；
- 消息明确说明本次点击只回答决定，不直接开始执行，也不替代后续 Gate；
- 输入框已有草稿时保留草稿并显示就地错误，不发送消息；
- 对话忙碌时禁用选项，工具关闭或入口不可用时显示原因；
- 未来公开推送等下游授权不再作为当前阻塞项，应保留为非阻塞问题或 `before_external_effect` Gate。

验证结果：

- 最终常规测试 `361/361`，Project Trust `4/4`，TypeScript、ESLint 与 diff 检查通过；
- Pi SDK `0.84.1`、Undici `8.9.0` 的 macOS arm64 隔离生产构建返回 HTTP 200；
- 浏览器读取到 3 个可用原生按钮，鼠标 hover 和 Enter 发送均生效；
- 输入框已有草稿时 Prompt 请求为 0、可见选择消息为 false，草稿原样保留；
- 发送后只有一个 `/api/agent/:sessionId` Prompt，请求正文是可见选择；没有 Task、Project 或其他 mutation，Task=0、Project=0；
- 发送期间选项禁用；390px 页面无 body 横向溢出；console error 为 0。

证据：

- `.runtime/macos-local-build-20260815-024050/result.json`
- `.runtime/decision-options-browser-20260815-024321/decision-options-browser-result.json`
- `decision-options-baseline.png`
- `decision-options-draft-protection.png`
- `decision-options-sent-wide.png`
- `decision-options-sent-narrow.png`

验收后 `31437` 隔离服务和 `9226` 隔离 Chrome 均已关闭；真实 `30142` 服务保持 HTTP 200。

## 6. 新发现的真实升级阻塞

`pi-task/main` 的源码声明 Pi SDK `0.84.1`、Undici `8.9.0`，但当前安装的 `node_modules` 分别仍为 `0.83.0`、`8.5.0`，`npm ls --depth=0` 返回 1；当前真实 `.next` 中也只检出 Pi `0.83.0` 标记。

因此，先前真实升级证明了源码路由、Task 数据备份／迁移和服务恢复可用，但不能继续把当前运行产物描述为完整的 Pi SDK 0.84.1 构建。

在下一次真实升级前必须单独确认以下操作：

1. 审查 `package.json` 与 `package-lock.json`；
2. 明确授权执行 `npm ci --include=dev --ignore-scripts`，重建主目录依赖；
3. 确认 `npm ls --depth=0` 通过且实际 Pi/Undici 版本与锁文件一致；
4. 再用现有备份、隔离构建、前台冒烟和回滚门升级真实服务。

当前没有执行依赖安装、真实数据迁移、服务升级或公开推送。

## 7. 后续确认门

1. 是否允许先重建 `pi-task/main` 依赖，再把本分支合入 `main` 并做真实升级验收；
2. 真实目录切换、普通对话、任务成形、看板、恢复和历史数据通过后，才准备公开快照；
3. 公开差异、测试和敏感信息审计通过后，仍需单独授权 `git push`。
