# Task Framing Slice C 交接

> 日期：2026-08-14
>
> 分支：`feat/moa-readonly-delegation`
>
> 状态：实现、自动测试与真实页面隔离验证完成，尚未提交；“确认并开始”仍禁用

## 1. 本切片目标

把 Session 中的候选任务约定安全提交到 SQLite：

- “保存草稿”只得到 `backlog`；
- “确认并放入待办”只得到 `ready`；
- 两条路径都不准备 Session、不创建 Run、不调用模型。

## 2. 已完成

- SQLite schema 升级到 v3；
- `tasks` 增加 rich contract、schema 和 revision；
- `runs` 增加 Task version 与合同快照字段；
- 增加 `task_framing_operations` 幂等操作表；
- 新增 `POST /api/task-framing` 与 `GET /api/task-framing`；
- 服务端只接受 Session/draft/Task/Project 引用，从 Session active branch 回读合同正文；
- 浏览器附带的合同 JSON 被忽略；
- 同时校验 active branch 最新草案、Project root、Session 主绑定、Task version、readiness 和活动 Run；
- 第一次显式保存即绑定主 Session；
- 保存/确认后追加 Session commit receipt，回执失败不回滚 SQLite 权威结果；
- operation 重试不重复创建 Task、Run 或回执；
- rich contract 确定性派生旧三字段；
- 旧三字段编辑 API 不允许覆盖 rich contract；
- rich contract 的阻塞 readiness 不能被 Task Board 手工移入 `ready`；
- Run 开始时已经保存 rich contract 快照，执行期 `read_task` 优先返回快照；
- 新增 declined/reopened Session preference API，不写 SQLite Task；
- 卡片启用“保存草稿”和“确认并放入待办”，继续禁用“确认并开始”。

## 3. 关键文件

- `lib/task/framing-commit.ts`
- `lib/task/framing-commit.test.mjs`
- `app/api/task-framing/route.ts`
- `app/api/sessions/[id]/task-framing/preference/route.ts`
- `lib/task/store.ts`
- `lib/task/store.test.mjs`
- `lib/task/types.ts`
- `lib/task/errors.ts`
- `components/tasks/TaskContractCard.tsx`
- `components/tasks/TaskContractCard.css`
- `components/MessageView.tsx`
- `components/ChatWindow.tsx`
- `components/AppShell.tsx`

## 4. 真实页面验证

页面：

```text
http://127.0.0.1:31433/?session=01a00022-7b1d-7ad2-a149-97bbf74f9bec
```

结果证据：

```text
.runtime/task-framing-slice-a-20260814-195732/slice-c-browser-result.json
.runtime/task-framing-slice-a-20260814-195732/task-framing-slice-c-confirmed.png
.runtime/task-framing-slice-a-20260814-195732/task-framing-slice-c-reloaded.png
```

真实点击结果：

1. 初始：保存与确认可用，确认并开始禁用；
2. 保存后：Task=`backlog`、Run=0、operation=`saved`；
3. 确认后：同一 Task=`ready`、Run=0、operations=`saved + confirmed`；
4. 刷新后：草稿保存与确认回执都从 Session 恢复；
5. 最终：Task=1、Run=0、合同 revision=1、Task version=2。

SQLite 与 Session 均位于：

```text
.runtime/task-framing-slice-a-20260814-195732/
```

## 5. 异常与修复

重启隔离开发服务时曾把已经是绝对路径的 runtime 再拼接一次当前目录，误建了一个项目内 `Users/...` 临时树。该树只有 3 个隔离 SQLite 文件，未访问真实用户目录，已整体移动并保留到：

```text
.runtime/task-framing-slice-c-accidental-env-root-20260814-2105
```

没有删除或覆盖原始资料。

## 6. 权限与未做事项

本切片没有：

- 自动准备 Task Session；
- 创建 Run；
- 自动发送开始 Prompt；
- 启用“确认并开始”；
- 调用真实 Provider、子 Agent 或外部服务；
- 合并、安装或发布。

## 7. 下一步

Slice D：一次性“确认并开始”意图、自动可见用户消息、Run 唯一性及失败补偿。任何失败必须保持 Task=`ready` 且无幽灵活动 Run。
