# Pi Task Gate D — D1/D2 完成交接（2026-08-05）

> **后续状态：** D3 已于同日完成；请以 [`2026-08-05-gate-d-d3-complete.md`](2026-08-05-gate-d-d3-complete.md) 作为 Gate D 的当前交接。本文件保留 D3 开始前的 D1/D2 证据与当时决策。

## 当时结论（D3 开始前）

Gate D 的 D1（对话转任务与同 Session 恢复）和 D2（人工输入、阻塞、取消）已完成实现与验收。**D3 尚未开始**；不要因本文件而开展合同编辑、拖拽/触控复核或生产打包。

## 已通过的证据

### D1

- 无模型冒烟覆盖了既有持久化 Session 绑定、`ready` 前不创建 Run、同 Session 重新准备、启动补偿中断与恢复。
- macOS 浏览器验收确认“整理为任务”表单、同 Session 的 `ready` 状态条、“继续处理 / 查看任务”、未发送的预填提示词和 SQLite 绑定。

### D2 浏览器验收

- macOS 隔离虚构页面依次完成 `ready → blocked → ready → canceled`。
- 阻塞、解除阻塞、取消均要求理由；最终详情显示状态/执行记录和理由。
- 视觉检查通过：底部操作未遮挡、阻塞和恢复信息可读、取消后没有“继续处理”、窄窗口未截断理由或控件。

### D1/D2 真实模型纵向验收

权威运行目录：`.runtime/external-gate-d-20260805-215735/`（已被 Git 忽略，仅含虚构数据）。

- Provider/model：`minimax-cn / MiniMax-M3`。
- 主流程：Task `tsk_948abfff-5f14-4859-9d21-6e54d7eabdfd` 复用 Session `019fd237-2a7e-7125-81e5-a2f153137f7c`；真实 free conversation 转为 Task 后，Agent 按顺序调用 `read_task`、`request_task_input`、`write`、`read`、`submit_task_review`；人工回复后在同一 Session 完成 `decision.md`，人工验收后 `Run=succeeded`、`Review=accepted`、`Task=done`。
- 事件顺序：`task.created → run.starting → run.running → run.waiting_user → run.resumed → review.submitted → review.accepted`。
- 真实 abort：Task `tsk_acf050c4-7315-49a1-897f-be50665f197a` 复用另一真实 Session。Runner 观察到未完成的长 Bash 调用和活跃 Agent 后发送取消；最终 `Run=canceled`、`Task=canceled`、无 Review，事件为 `task.created → run.starting → run.running → run.canceled → task.canceled`。Session 最后一轮为 `aborted`，Bash tool result 为错误，说明取消在迟到 Review 前生效。
- 11 次 provider 请求，SDK 报告 82,417 总 tokens（含 cache reads）与 USD 0.01362426；隔离 `pi/auth.json` 为 `{}`，Key 未写入运行目录或结果文件。

## 测试工具与安全边界

- `scripts/run-gate-d-external.sh`：交互式真实模型验收；仅在用户明确允许真实调用和费用后运行。
- Key 通过隐藏终端输入，仅作为隔离 Next 服务进程环境变量使用；服务退出后清除；不要把 Key 粘贴到聊天、结果文件或 Git。
- `scripts/gate-d-external.mjs` 会保存非敏感 `result.json`：不保存用户回答明文，仅保存其长度和 hash。
- Runner 已通过 `node --check`、`bash -n`、`npm run lint` 和 `node_modules/.bin/tsc --noEmit`。

## 已知历史异常

`.runtime/external-gate-d-20260805-214820/` 的第一次真实模型测试已通过主流程，但旧 Runner 用 `isBashRunning` 判断 Agent 内部 Bash，未能可靠观测到同回合 tool call，因此没有真正发送取消。该目录不能作为 abort 验收依据。提交 `6998f3c` 改为观察运行中标记、未完成 Bash tool call 和活跃 Prompt；后续 `215735` 是有效的最终证据。

## 相关提交

- `99dd5dd docs: record Gate D conversation entry acceptance`
- `1ad48b4 feat: add task blocking and recovery states`
- `8d1c5ef docs: record Gate D D2 browser acceptance`
- `2e28fd0 test: add Gate D external validation runner`
- `6998f3c test: make Gate D abort probe deterministic`

## 下一步

若要继续，先单独确认 D3 的目标和验收口径。D3 候选范围仍是：合同编辑与乐观版本校验、未完整合同的不可启动提示、桌面拖拽/同列排序/触控回退的真实浏览器复核。不要自动复跑真实模型验收，也不要开始生产打包。
