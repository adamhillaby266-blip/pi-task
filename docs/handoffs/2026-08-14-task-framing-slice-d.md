# Task Framing Slice D 交接

> 日期：2026-08-14
>
> 分支：`feat/moa-readonly-delegation`
>
> HEAD：`40bb8397056388233ef09aa573005979c0d24a74`
>
> 状态：Slice D 实现并完成成功/失败隔离验证，尚未提交；Slice E 只新增了一个未接线的 Store 绑定原语

## 1. 当前目标与边界

Task Framing Slice D 要把卡片上的“确认并开始”落实为一次用户动作，同时维持既定权限边界：

- 用户一次点击表达确认与开始意图；
- SQLite、Session JSONL 与 Pi Runtime 不伪装成跨系统原子事务；
- 最多产生一个活动 Run；
- 自动开始必须表现为同一对话中的可见用户消息；
- 准备、Run 创建、Prompt 派发或恢复失败时，Task 回到 `ready`，活动 Run 为空；
- Agent 仍不能确认合同、接受 Review 或完成 Task。

没有使用真实 Provider、真实凭据或共享数据；没有合并、安装、提升构建产物或发布。

## 2. Slice D 已完成

### 2.1 幂等 operation 与 Store

- `confirm_and_start` commit 将 Task 确认为 `ready`，operation 写为 `awaiting_start`，但不立即创建 Run；
- `/api/tasks/:id/start` 接受 `operationId`，在同一个 Store 事务里把 operation 关联到唯一 Run；
- operation 状态支持 `awaiting_start → started / start_failed`；
- 同 operation 重试返回已有 Run，不重复创建；
- `start_failed` 后可用同一 operation 重试；
- `beginRun()` 保存确认时的 rich contract、contract revision 与 Task version 快照；
- `failRun()` 与启动期重启收敛会自动把关联的 `started` operation 改为 `start_failed`，避免 Task 已恢复但按钮永久锁死；
- commit 同时写 `run.start_requested` Task Event。

### 2.2 一键 UI 编排

- `TaskContractCard` 已启用“确认并开始”；
- 卡片仍只提交 Session、draft、Task、Project 和 operation 引用，不提交合同正文；
- `AppShell` 先准备主 Task Session，再登记一次性 start intent；
- 目标 Session 就绪后自动送出可见用户消息：

```text
我已确认任务约定并选择现在开始。请按该约定开始 Run N。
```

- `ChatInput.sendIfEmpty()` 只在输入框为空且 Agent 空闲时执行，不覆盖用户草稿；
- 程序化消息使用 `programmatic` 标记，失败后不会把系统生成的开始语句回填到输入框。

### 2.3 Prompt 与失败补偿

- `useAgentSession` 在真正发送 Prompt 前调用 `/api/tasks/:id/start`；
- `AgentCommandRejectedError` 区分明确 HTTP 拒绝与不确定网络失败；
- 明确拒绝、工具禁用、Prompt 异常或异常空闲都会中断活动 Run并调用补偿 API；
- 新增 `POST /api/task-framing/start-failed`；
- 补偿后追加 `start_failed` Session receipt；回执失败不覆盖 SQLite 权威结果；
- UI 把失败回执标为“启动失败，Task 保持待办”。

### 2.4 相关文件

- `app/api/tasks/[id]/start/route.ts`
- `app/api/task-framing/start-failed/route.ts`
- `components/AppShell.tsx`
- `components/ChatInput.tsx`
- `components/tasks/TaskContractCard.tsx`
- `hooks/useAgentSession.ts`
- `lib/agent-client.ts`
- `lib/task/framing-commit.ts`
- `lib/task/runtime.ts`
- `lib/task/store.ts`
- `lib/task/types.ts`
- `lib/task/framing-start.integration.test.mjs`

## 3. 验证结果

### 3.1 faux Provider 成功路径

测试：

```text
lib/task/framing-start.integration.test.mjs
```

覆盖并通过：

1. commit 后 Task=`ready`、Run=0、operation=`awaiting_start`；
2. prepare 后 start 创建唯一 Run；
3. 同一主 Agent 收到且只保存一条可见开始消息；
4. faux Agent 读取 Task、提交已有虚构文件给 Review；
5. 最终 Task=`in_review`、Run=`succeeded`、Review=1；
6. Run 使用确认合同快照；
7. 同 operation 再次调用 start，Run 总数仍为 1；
8. faux Provider 总调用 3 次，没有额外 Agent。

### 3.2 真实页面失败补偿

页面：

```text
http://127.0.0.1:31433/?session=01a00022-7b1d-7ad2-a149-97bbf74f9bec
```

隔离 runtime：

```text
.runtime/task-framing-slice-a-20260814-195732
```

证据：

```text
.runtime/task-framing-slice-a-20260814-195732/slice-d-failure-browser-result.json
.runtime/task-framing-slice-a-20260814-195732/task-framing-slice-d-start-failed.png
```

真实点击“确认并开始”后，隔离 Session 因没有可用 faux Runtime，事件流连接超时。系统收敛结果：

- Task=`ready`；
- activeRunId=`null`；
- 唯一历史 Run=`interrupted`；
- operation=`start_failed`；
- 失败 operation 关联该历史 Run；
- `confirmAndStart=true`，允许用户重试；
- 没有调用真实模型或外部 Provider。

之后已通过补偿 API补写 Session failure receipt。该次失败中可见开始消息已进入 Session，但没有模型回答；这符合“可见意图 + 失败留痕”，重试时应开始 Run 2。

### 3.3 自动测试

最近一次定向结果：43 项通过，包括：

- Store 幂等与最多一个活动 Run；
- framing commit；
- faux 成功集成；
- ChatInput 程序化意图；
- AppShell UI 编排；
- useAgentSession 补偿；
- Task Framing UI 投影。

同时通过：

```text
tsc --noEmit
npm run lint
git diff --check
```

注意：在最后加入 Slice E 的单个 Store 方法后，又单独通过了 `tsc --noEmit` 与 `git diff --check`；完整广覆盖测试尚未在 Slice D 最终状态重跑。

## 4. Slice E 仅开始、尚未完成

`lib/task/store.ts` 已新增：

```text
bindTaskPrimarySession(taskId, version, sessionId)
```

它用于未来 `POST /api/tasks/:id/framing-session`：只允许 `backlog` 或无活动 Run 的 `ready` Task，用乐观锁绑定普通 Framing Session，并阻止一个 Session 绑定第二个 Task。

当前没有：

- framing-session runtime 服务；
- framing-session API；
- Task Board“和 Pi 一起补全”入口；
- SQLite 旧三字段 Task → 候选任务约定适配流程；
- Slice E 测试或真实页面验证。

下一位不要误把这个 Store 方法当成 Slice E 已完成。若实现方案改变，可以在不影响 Slice D 的前提下重做或撤回该方法。

## 5. 当前运行状态

- 分支：`feat/moa-readonly-delegation`
- HEAD 仍为第一阶段提交：`40bb8397056388233ef09aa573005979c0d24a74`
- 工作树不干净；MoA、Task Framing A–D、产品文档与原型混在一起，尚未拆分提交；
- 隔离开发服务：PID `71578`
- 服务：`http://127.0.0.1:31433/`，交接时 HTTP 200；
- 服务环境的 `HOME`、`TMPDIR`、`PI_CODING_AGENT_DIR`、`PI_TASK_DATA_DIR` 均在上述 `.runtime/`；
- 常见 Provider API key 在本次重启时显式置空；
- 不要操作真实 `~/.pi/agent`、`~/.pi-task` 或当前安装。

## 6. 下一步建议

1. 新会话先读本交接、`task-framing-technical-design.md`、Slice A–C 交接；
2. 先补跑最终广覆盖测试，确认 D 的最终补偿改动无回归；
3. 再继续 Slice E：framing-session 准备路径、API、Task Board 入口与 legacy adapter；
4. framing-session 必须不创建 Run、不加载 Run capability、不自动发送 Prompt；
5. 旧表单不要因“代码已经能跑”就立即删除，仍应按冻结设计先观察回退使用情况；
6. 提交前必须把 SDK、MoA、Task Framing 文档/原型和 A–E 产品切片拆分，不要形成一个无说明的大提交；
7. 未经用户再次确认，不合并到 `main`、不操作真实安装、LaunchAgent 或发布。
