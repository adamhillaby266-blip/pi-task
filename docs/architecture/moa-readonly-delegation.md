# MoA 只读委派合同

> 状态：第二阶段实验切片；实现默认关闭，只有显式设置 `PI_TASK_ENABLE_READONLY_MOA=1` 才加载入口，Task Framing 观察期内不进入发布默认能力
>
> 基线：Pi SDK 0.84.1，提交 `40bb839` 之后
>
> 目标：让一个受控 Task Run 在用户确认后调用多个独立上下文的只读 Pi Agent，并把结果作为父 Run 的证据保存；不是开放无人值守多 Agent。

## 1. 产品判断

Pi Task 的 MoA 不是“多个角色看起来很热闹”，也不是多个 Agent 自由抢同一个 Task。它只解决一个问题：当复杂任务需要独立查证、比较或反向审查时，主 Agent 可以并行取得多个相互隔离的视角，再由主 Agent 统一综合、实施、验证和提交 Review。

权威关系保持不变：

- Task/Run/Review/Event 仍以 Pi Task SQLite 为准；
- 主 Pi Session 仍是用户看到和继续修改的唯一协调对话；
- 子 Agent 是父 Run 的 Delegation 证据，不是新的 Task Run；
- 子 Agent 没有 Run capability，不能改变 Task/Run、登记 Artifact、提交或接受 Review；
- 用户仍独占最终 `done` 权限。

## 2. 第一版范围

支持：

- 一次调用 2–4 个子 Agent，最多 3 个并发；
- 固定的 `scout`、`analyst`、`critic` 三种只读分析配置；
- 子 Agent 继承父 Agent 当前 Provider、模型和推理等级；
- 每次调用前通过 Web Extension UI 明确提示额外模型调用并等待用户确认；
- 子 Agent 使用独立 Pi 进程和独立上下文，不保存 Session；
- 逐个记录状态、输出、错误、用量、模型和时间；
- 父 Run 取消时向子进程传播终止信号；
- 服务重启、Task 阻塞/取消或父 Run 失败时，所有活动 Delegation 同步收敛；
- Task 详情展示持久化协作记录。

不支持：

- 子 Agent 写文件、运行 Bash、调用项目 Extension/Skill 或读取上下文文件；
- 子 Agent 各自提交 Review；
- 多个写入 Agent 并行修改同一目录；
- 自动调度、自动认领、后台周期任务；
- 跨 Task 编排、自由竞争、可视化流程编辑器；
- 把进程隔离宣传为容器或操作系统安全沙箱。

## 3. 运行路径

1. 用户启动一个正常 Task Run，并在主 Pi 对话发送任务。
2. 主 Agent 判断独立视角能实质降低风险时，调用 `delegate_readonly_agents`，提交 2–4 个聚焦问题。
3. Pi Task 显示子 Agent 数量、固定模型和额外调用说明；用户确认后才继续。
4. SQLite 在父 Run 下原子登记一批 `running` Delegation，并写入 `delegation.started` 事件。
5. 每个子进程以以下固定边界启动：
   - `--mode json --print --no-session`；
   - `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve`；
   - 只启用 `read,grep,find,ls`；
   - 只额外加载 Pi Task 自带的路径守卫；
   - 任务内容写入权限为 `0600` 的临时文件，不进入进程命令行；
   - 临时目录位于 Pi Task 数据目录并在结束后删除。
6. 路径守卫对真实路径执行 `realpath` 检查，阻止绝对路径和符号链接逃逸项目根目录。
7. 每个子进程完成后记录 `succeeded/failed/canceled`、最终文本、错误和用量，并向主 Agent流式更新完成数量。
8. 主 Agent获得截断后的多份输出，负责重新核实、综合、实施和最终 `submit_task_review`；完整委派输出保留在 Task Delegation 记录中。

## 4. 数据合同

新增 `delegations` 表：

- `id`、`batch_id`、`task_id`、`run_id`；
- `profile`、`prompt`、`model`；
- `status`：`running/succeeded/failed/interrupted/canceled`；
- `output`、`error`、`usage`；
- 创建、开始、结束和更新时间。

约束：

- 同一父 Run 同时只能存在一批活动 Delegation；
- Delegation 必须绑定当前活动父 Run capability 后才能创建或完成；
- 存在活动 Delegation 时，父 Agent 不能提交 Review；
- Delegation 状态变化不冒充 Task 版本变化，但写不可变 Event；
- 父 Run 收敛时，活动 Delegation 必须在同一 SQLite 事务中收敛。

数据库 `user_version` 从 1 提升为 2，只新增表和索引，不修改现有 Task、Run、Artifact、Review 或 Event 行。

## 5. 安全边界

- 不把 API Key、OAuth token 或原始凭据写入 SQLite、Session、命令行、临时提示或日志；子进程只从既有 `PI_CODING_AGENT_DIR` 解析认证。
- 子进程不继承父 Session 标识环境变量，也不获得 Task capability。
- 项目资源发现全部关闭，避免仓库控制的 Agent/Extension/Skill 在子进程执行。
- 工具路径守卫只限制 Pi 工具访问；它不是系统级沙箱。未来若开放写入型或不可信子 Agent，必须改用容器、VM 或等价系统隔离。
- 子 Agent 输出进入父模型上下文前按每个 Agent 10 KiB 截断；完整持久化输出上限为 100 KiB，避免上下文失控。

## 6. 失败与恢复

| 场景 | 结果 |
|---|---|
| 用户拒绝额外模型调用 | 不创建 Delegation，父 Run 继续 |
| 子进程启动失败/Provider 错误 | 对应 Delegation=`failed`，其他结果仍返回主 Agent |
| 用户停止父 Agent | 子进程先 SIGTERM、超时后 SIGKILL；Delegation=`canceled`，父 Run按既有规则中断 |
| Task 被阻塞 | 活动 Delegation=`interrupted`，父 Run=`interrupted`，Task=`blocked` |
| Task 被取消 | 活动 Delegation=`canceled`，父 Run和 Task按既有取消合同收敛 |
| 服务重启 | 活动 Delegation=`interrupted`，父 Run=`interrupted`，Task 回 `ready` |
| 子 Agent 访问根目录外路径 | 工具调用被守卫阻断并形成失败证据 |
| Delegation 尚未结束时提交 Review | 服务端拒绝 |

## 7. 验收标准

- 使用虚构数据和空认证替身验证数据库迁移与全生命周期；
- 真实 Pi 0.84 CLI 能在隔离目录中加载显式 faux Provider 和路径守卫，完成无网络子进程调用；
- 2–4 个并行子进程状态和顺序稳定，取消可传播，临时文件全部清除；
- 根目录外绝对路径和符号链接逃逸均被拒绝；
- Task 详情能区分子 Agent 的角色、状态、模型、输出、错误和用量；
- 既有单 Agent Task/Run/Review、Gate D 和 macOS 构建不回归；
- 不操作真实 Provider、真实 Task 数据、当前安装、LaunchAgent 或对外发布。
