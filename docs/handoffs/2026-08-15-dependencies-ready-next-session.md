# Pi Task 新会话交接：依赖已就绪，待合入与真实升级

> 日期：2026-08-15
>
> 当前阶段：依赖重建与核验已完成；功能分支尚未合入，真实服务尚未升级，公开仓库尚未推送。

## 1. 本轮目标与授权边界

用户只授权了在 `pi-task/main` 执行依赖重建与核验。已执行：

```bash
npm ci --include=dev --ignore-scripts
```

npm 缓存、临时文件和证据均放在项目内 `.runtime/`。本轮没有：

- 合入 `feat/single-workspace-core`；
- 停止或升级真实服务；
- 迁移真实 Task 数据；
- 修改 `pi-task-public`；
- 执行 `git push` 或其他 GitHub 操作。

## 2. 当前三个源码位置

### `pi-task`

- 分支：`main`
- HEAD：`c87446d`
- 工作树：干净
- 已安装 Pi SDK：`0.84.1`
- 已安装 Undici：`8.9.0`
- `npm ls --depth=0 --silent`：退出码 0
- 真实服务：`http://127.0.0.1:30142` 返回 HTTP 200
- 真实 `.next` 仍是旧产物，仍检出 Pi `0.83.0` 标记；本轮刻意未替换

### `pi-task-worktrees/single-workspace-core`

- 分支：`feat/single-workspace-core`
- 功能与产品文档提交截至：`d78ec56`
- 已完成单一工作目录、对话式任务入口和可点击阻塞决定
- 可点击选项修复提交：`cb5226f`
- 此交接文件是其后的文档记录

### `pi-task-public`

- `main@f08ca38`
- 与 `origin/main` 一致
- 工作树干净
- 尚未同步或推送本轮源码

## 3. 依赖重建结果

重建前：

- Pi SDK `0.83.0`
- Undici `8.5.0`
- `npm ls` 退出码 1

重建后：

- Pi SDK `0.84.1`
- Undici `8.9.0`
- `npm ls` 退出码 0
- 代理回归测试通过
- TypeScript、ESLint 通过
- `pi-task/main` 常规测试 `353/353`
- Project Trust `4/4`
- 工作树仍干净

npm 输出包含既有 React peer-dependency、弃用警告，以及一个由锁文件可选 WASM 依赖产生的 `@emnapi/runtime@1.9.1 extraneous` 元数据项。它没有导致 `npm ls` 失败，也未影响测试或构建；后续不得为消除提示擅自改锁文件或新增依赖。

证据目录：

- `pi-task/.runtime/dependency-rebuild-20260815-030019/`

## 4. 隔离生产构建

使用重建后的主目录依赖完成 macOS arm64 隔离生产构建：

- 运行目录：`pi-task/.runtime/macos-local-build-20260815-030634/`
- 页面：HTTP 200
- `auth=absent`
- 未写入真实 `.next`
- 未读取真实 Pi 或 Task 数据
- 隔离端口 `31438` 已关闭
- 候选产物中 Pi `0.83.0` 标记文件数：0
- 候选产物中 Pi `0.84.1` 标记文件数：7

## 5. 功能分支已验证内容

`feat/single-workspace-core` 已完成并验证：

- 当前工作目录作为唯一用户上下文；
- 用户侧取消独立 Project 选择和新建；
- Task Board 跟随工作目录；
- 自然对话是 Task Framing 主入口；
- 实际加载的规则来源可见，但不泄露正文；
- 阻塞决定选项为原生按钮；
- 鼠标、键盘和 390px 页面可用；
- 有输入草稿时不覆盖、不发送；
- 对话忙碌时禁用；
- 点击只发送可见用户消息，不创建 Task、Project、Run，也不直接执行外部操作。

分支最终验证为常规测试 `361/361`、Project Trust `4/4`、TypeScript、ESLint、macOS arm64 构建和虚构浏览器验收通过。完整证据见：

- `docs/handoffs/2026-08-15-single-workspace-core.md`
- `.runtime/decision-options-browser-20260815-024321/`

## 6. 当前未授权事项

以下事项仍需分别明确确认：

1. 把 `feat/single-workspace-core` 合入 `pi-task/main`；
2. 停止真实服务、备份 Task SQLite、构建并安装新 `.next`、恢复服务；
3. 使用真实目录、历史对话和任务看板做人机验收；
4. 审计并同步到 `pi-task-public`；
5. 执行任何 `git push` 或 GitHub 修改。

当前候选任务约定为 revision 4、Session entry `bde34eb3`。它没有创建或修改 Task/Run；依赖重建已完成，但“合入并真实升级”仍应视为待确认 Gate。未来公开推送是非阻塞下游决定。

## 7. 新会话建议执行顺序

1. 先读取本文件和 `docs/handoffs/2026-08-15-single-workspace-core.md`；
2. 复核三个源码位置、HEAD、工作树和 `30142` 服务状态；
3. 把“依赖重建”标记为已解决，不重复执行 `npm ci`；
4. 向用户报告合入、停服、备份、升级和回滚影响，取得新的明确授权；
5. 获授权后，先在 `main` 合入功能分支并重跑关键检查；
6. 使用既有升级脚本，在停服后备份 Task SQLite，完成隔离构建、前台冒烟、服务恢复和真实浏览器验收；
7. 真实验收通过后再准备公开快照；公开推送继续单独确认。

不要重新开发 Slice F，不要启用默认 MoA，不要删除旧工作树、恢复快照或真实数据。
