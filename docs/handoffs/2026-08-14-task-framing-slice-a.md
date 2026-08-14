# Task Framing Slice A 交接

> 日期：2026-08-14
>
> 分支：`feat/moa-readonly-delegation`
>
> 状态：代码、隔离验证与用户真实页面确认均已完成，尚未提交

## 1. 本切片目标

只实现结构化任务约定和 Session → Web UI 的只读投影，不接模型工具、不写 Task 合同、不创建 Run。

## 2. 已完成

- 新增 `TaskContractV1`、严格解析、大小限制、重复 id 检查和文字可信度状态；
- 新增无百分比评分的就绪检查；
- 新增丰富合同到现有 `goal / acceptanceCriteria / expectedOutput` 的确定性投影；
- 旧三字段可适配为显式“未重新确认”的阻塞候选草案；
- 定义 `pi-task.task-framing` Session custom entry v1；
- 只从当前 Session branch 投影草案， sibling branch 不泄漏；
- Pi compaction 裁掉旧历史时恢复最新候选草案；
- 旧草案折叠，最新版按 Pi Task 视觉显示完整任务约定卡；
- Framing 卡不进入模型上下文，也不折叠进 Agent“过程详情”；
- Slice A 三个动作全部为显式禁用状态，没有 API mutation。

## 3. 关键文件

- `lib/task/contract.ts`
- `lib/task/contract.test.mjs`
- `lib/task/framing-session.ts`
- `lib/task/framing-session.test.mjs`
- `lib/session-reader.ts`
- `lib/session-reader.test.mjs`
- `components/tasks/TaskContractCard.tsx`
- `components/tasks/TaskContractCard.css`
- `components/tasks/TaskContractCard.classes.ts`
- `components/tasks/TaskFramingProjection.test.mjs`
- `components/MessageView.tsx`
- `components/ChatWindow.tsx`
- `docs/architecture/task-framing-technical-design.md`

## 4. 隔离页面

```text
http://127.0.0.1:31433/?session=01a00022-7b1d-7ad2-a149-97bbf74f9bec
```

运行目录：

```text
.runtime/task-framing-slice-a-20260814-195732
```

截图：

```text
.runtime/task-framing-slice-a-20260814-195732/task-framing-page.png
```

页面使用直接写入的虚构 Session 条目，无 Provider、无凭据、无模型调用。API 回读结果：

- 两张 Framing 卡；
- 草案 1：`ready=false`、已由草案 2 取代；
- 草案 2：`ready=true`；
- messages / entryIds 对齐；
- SQLite Task 数量为 0。

## 5. 验证结果

- TypeScript：通过；
- ESLint：通过；
- `git diff --check`：通过；
- Slice A 与相关专项：35 项通过；
- 除 `project-trust.test.mjs` 外广覆盖：324 项通过；
- Project Trust 可在当前工作区成立的 4 项：通过；
- 工作区祖先存在 `.agents/skills` 的兼容行为：单独验证为 `requiresTrust=true, trusted=false`。

`project-trust.test.mjs` 的“clean projects”用例在强制把 `TMPDIR` 放入本工作区时不能满足其原始前提：SDK 会按设计向上发现工作区根 `.agents/skills`，因此该 fixture 不再是 clean project。此现象与 Slice A 无关，没有修改测试或安全逻辑来掩盖它。

测试中仍只有既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。

## 6. 权限与未做事项

本切片没有：

- 修改 SQLite schema；
- 创建或更新真实 Task；
- 启动 Run；
- 加载 Framing Extension；
- 调用模型或子 Agent；
- 启用保存、确认或开始按钮；
- 合并、安装或发布。

当前工作树还混有未提交的 MoA 实验改动。提交前必须按切片拆分，不能把两类改动无说明混成一个提交。

## 7. 后续状态

用户已确认真实页面没有问题；Slice B 已继续实施。详见：

```text
docs/handoffs/2026-08-14-task-framing-slice-b.md
```
