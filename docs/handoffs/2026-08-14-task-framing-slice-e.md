# Task Framing Slice E 交接

> **后续状态：** Slice A–E 已完成独立审查修正并整理为 `release/task-framing-candidate` 发布候选；当前交接见 [`2026-08-14-task-framing-release-candidate.md`](2026-08-14-task-framing-release-candidate.md)。本文件保留审查与提交前的 Slice E 证据。
>
> 日期：2026-08-14
>
> 分支：`feat/moa-readonly-delegation`
>
> HEAD：`40bb8397056388233ef09aa573005979c0d24a74`
>
> 状态：Slice E 已实现并完成自动与真实页面隔离验证，尚未提交；没有合并、安装或发布

## 1. 本切片目标与结果

Slice E 已把 backlog/legacy Task 接入任务约定流程，同时维持冻结边界：

- `backlog` 与无活动 Run 的 `ready` Task 可从 Task Board 进入“和 Pi 一起补全”；
- 新增 `POST /api/tasks/:id/framing-session`；
- 有有效 `primarySessionId` 时恢复原 Session，否则创建并乐观锁绑定一个普通 Pi Session；
- Framing Session 不创建 Run、不加载 Run capability、不自动发送 Prompt；
- 旧三字段 Task 通过 `system_legacy_adapter` 生成候选 `TaskContractV1`，不会伪装成已确认 rich contract；
- Task Board 增加 rich contract 摘要，显示 outcome、受众、权威来源、交付、验收、readiness 与边界；
- 旧字段编辑和旧创建表单继续保留并标注为回退入口，没有提前删除。

## 2. 关键实现

### 2.1 Framing Session 服务

新增：

- `lib/task/framing-session-runtime.ts`
- `app/api/tasks/[id]/framing-session/route.ts`

服务校验：

- Task version；
- Task 必须为 `backlog` 或无活动 Run 的 `ready`；
- 既有 Session 必须真实持久化且 cwd 位于 Project root；
- 一个 Session 不能绑定第二个 Task；
- 并发绑定使用 `bindTaskPrimarySession()` 乐观锁，冲突时新 Session 作为普通对话保留但不绑定、不执行。

Pi SDK 默认在出现 assistant message 前延迟首次 Session flush。Slice E 不伪造消息，而是先写入 Session header / `session_info`，再通过公开 `SessionManager.open()` 重新打开，之后追加 custom draft；因此空澄清对话可以持久存在，同时消息数仍为 0。

如果既有执行 Session 仍加载 Task Extension，但已经没有活动 Run，服务会先清除旧 Run binding 并正常 shutdown，再按普通 Framing Session 重开，不把执行能力带入澄清流程。

### 2.2 legacy adapter 与冲突保护

- 复用 `createLegacyTaskContractCandidate()`；
- 候选带 `taskId`、`baseTaskVersion` 和 `createdBy=system_legacy_adapter`；
- 旧字段在候选创建后被另一窗口修改时，commit 返回 `VERSION_CONFLICT`；
- 只有当前 SQLite 合同正文与候选一致时，纯队列 version 变化才不制造假冲突；
- 同一 Session 重复进入不重复追加候选。

### 2.3 Task Board 与 AppShell

- backlog 卡片和详情提供“和 Pi 一起补全”；
- incomplete ready Task 不再只有禁用按钮，可直接进入澄清；
- rich contract 详情显示紧凑摘要，不重复三字段投影；
- `AppShell.handleFrameTask()` 只切换到目标 Session，明确清空 pending Run / Prompt；
- 旧字段直接编辑保留为“临时回退入口”。

## 3. 自动验证

进入 Slice E 前先复核 Slice D 完成态：

- 常规测试：343 项通过；
- 工作区兼容 Project Trust：4 项通过；
- TypeScript、ESLint、`git diff --check` 通过。

Slice E 完成态：

- 常规测试：348 项通过；
- 工作区兼容 Project Trust：4 项通过；
- TypeScript、ESLint、`git diff --check` 通过；
- 新增覆盖：Session 绑定乐观锁、legacy adapter、同 Session 幂等恢复、无 Run/无 capability/无自动 Prompt、旧候选版本冲突、Task Board 入口与 rich summary。

日志：

```text
.runtime/task-framing-slice-e-final-20260814-223057/
```

仍只有既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。clean-project Project Trust fixture 仍因工作区祖先真实存在 `.agents/skills` 不适用，没有修改安全逻辑或测试掩盖它。

## 4. 真实页面隔离验证

运行目录：

```text
.runtime/task-framing-slice-e-browser-20260814-222613/
```

交接时隔离开发服务为 `http://127.0.0.1:31434/`（PID `74156`，HTTP 200）；`HOME`、`TMPDIR`、`PI_CODING_AGENT_DIR` 与 `PI_TASK_DATA_DIR` 均指向该 runtime，常见 Provider key 显式置空。

证据：

```text
slice-e-browser-result.json
slice-e-state-result.json
task-framing-slice-e-rich-summary.png
task-framing-slice-e-legacy-candidate.png
task-framing-slice-e-legacy-candidate-narrow.png
```

真实点击 legacy backlog 的权威结果：

- Task=`backlog`；
- version 从 1 变为 2（主 Session 绑定）；
- activeRunId=`null`；
- Run=0；
- Session custom framing draft=1；
- user message=0；
- assistant message=0；
- 输入框为空；
- 运行中 Session 列表为空；
- draft=`system_legacy_adapter`，`baseTaskVersion=2`。

页面检查：

- rich contract 摘要在 1440×1000 中层级清楚；
- legacy candidate 在 1440×1000 与 390×844 均可读；
- 390px 下 card 宽 358px，页面 `scrollWidth=390`，没有横向溢出；
- 没有调用真实 Provider、真实模型、凭据或外部服务。

## 5. 当前边界与后续

- 旧表单尚未删除；应先观察真实回退使用，不因 Slice E 已能运行就提前移除。
- 工作树仍混有 SDK、MoA、Task Framing A–E、文档与原型的未提交改动；提交时必须拆分，不要形成一个无说明大提交。
- 未经用户再次确认，不合并 `main`，不操作真实安装、LaunchAgent 或发布。
