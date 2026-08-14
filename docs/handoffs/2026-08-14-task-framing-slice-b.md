# Task Framing Slice B 交接

> 日期：2026-08-14
>
> 分支：`feat/moa-readonly-delegation`
>
> 状态：实现与隔离验证完成，尚未提交；未启用候选卡保存或确认动作

## 1. 本切片目标

让同一个正常对话中的主 Agent 能建议任务化并起草结构化候选任务约定。候选只写入 Session JSONL，不创建 Task、Run 或委派 Agent。

## 2. 已完成

- 新增全局可信 `pi-task-framing` Inline Extension；
- 普通 RPC Session 默认加载 Framing Extension，执行期 Task Extension 仍保持独立权限；
- 新增 `suggest_task_framing`：同一 active branch 最多记录一次低压力建议；
- 新增 `propose_task_contract`：严格解析 `TaskContractV1`，追加版本化候选草案；
- 草案修订必须携带最新 `replacesEntryId`，过期覆盖返回 `DRAFT_STALE`；
- 已拒绝分支、已绑定 Task 的重复建议、活动 Run 修改合同均被阻止；
- `before_agent_start` 只注入最新候选的压缩摘要，同时保留 SQLite Task 的权威地位；
- Framing 工具关闭时不注入系统提示；
- 顶部主入口改为“一起把任务聊清楚”，点击后发送一条可见用户意图；
- 忙碌、输入框已有草稿或工具关闭时不覆盖用户状态，并显示具体原因；
- 旧表单暂以次级“直接填写”保留为回退入口。

## 3. 关键文件

- `lib/task/framing-extension.ts`
- `lib/task/framing-extension.test.mjs`
- `lib/task/framing-extension.integration.test.mjs`
- `lib/task/framing-session.ts`
- `lib/task/framing-session.test.mjs`
- `lib/rpc-manager.ts`
- `components/AppShell.tsx`
- `components/ChatInput.tsx`
- `components/tasks/GateDConversationFlow.test.mjs`

## 4. faux Provider 验证

集成测试通过真实 `startRpcSession()` 加载：

1. 内置 Framing Extension；
2. 测试专用 faux Provider；
3. 同一个主 Agent Session。

主 Agent 调用 `propose_task_contract`，Session 中只产生一个 `pi-task.task-framing` 候选条目。下一轮系统 Prompt 能恢复该条目的最新摘要。

实际结果：

- faux Provider 调用：3 次（第一次正常工具循环 2 次，后续主 Agent 对话 1 次）；
- Framing 草案：1；
- Task 数据库：未创建；
- Task：0；
- Run：0；
- Delegation：0；
- 额外 Agent 进程：0。

## 5. 页面检查

入口截图：

```text
.runtime/task-framing-slice-a-20260814-195732/task-framing-slice-b-entry.png
```

真实开发页面确认了主入口和次级回退入口仍位于 Pi Task 顶部状态条内，没有另建工作区。

## 6. 验证结果

- TypeScript：通过；
- ESLint：通过；
- `git diff --check`：通过；
- Slice A/B、RPC 与 SDK 定向验证：54 项通过；
- 最终广覆盖（不含不适用的 clean-project fixture）：335 项通过；
- 当前工作区可成立的 Project Trust：4 项通过。

`project-trust.test.mjs` 的 clean-project fixture 仍因工作区祖先真实存在 `.agents/skills` 而不满足“clean”前提；没有修改安全逻辑或测试来掩盖该环境差异。

## 7. 权限与未做事项

本切片没有：

- 修改 SQLite schema；
- 保存或确认 rich contract；
- 绑定候选 Session 到 Task；
- 创建或启动 Run；
- 启用卡片底部三个 mutation 按钮；
- 调用真实 Provider、子 Agent 或外部服务；
- 合并、安装或发布。

当前工作树仍混有未提交 MoA 实验代码，提交前必须拆分。

## 8. 下一步

Slice C：

1. SQLite schema v3 与 rich contract；
2. `task_framing_operations` 幂等记录；
3. commit API 从 Session entry 回读正文；
4. “保存草稿”写 `backlog`；
5. “确认并放入待办”写 `ready`；
6. 两条路径均不创建 Run。
