# Task Framing 技术设计

> 状态：设计基线已确认；Slice A–E 已完成并通过真实升级验收；后续单一工作目录减法切片已移除新任务的旧表单入口，历史 Task 的旧字段编辑仅保留为兼容回退
>
> 依赖：`docs/architecture/task-framing.md`、`docs/product/task-framing-card.md`
>
> 交互基线：`docs/product/prototypes/task-framing-card/index.html` 的 Pi Task 视觉版本已于 2026-08-14 通过人工检查；信息层级、纵向滚动和底部操作可达性已确认
>
> 本文目标：冻结候选草案、丰富合同、Session 绑定、并发控制和“确认并开始”的技术语义。本文不授权接入真实 Provider、合并、安装或发布。

## 1. 结论摘要

第一实现切片采用以下方案：

1. **候选任务约定保存在 Pi Session JSONL 的自定义状态条目中**，不是 SQLite Task，也不进入模型上下文。
2. **主 Agent 通过受限工具提出候选草案**；该工具只能追加草案，不能创建 Task、确认合同或开始 Run。
3. **Web 端把指定自定义状态条目投影为任务约定卡**；投影只影响显示，不改变 Pi 的模型上下文。
4. **用户显式保存或确认时，服务端根据 Session 中指定的草案条目写入 SQLite**，不接受浏览器重新提交一份可被篡改或过期的合同正文。
5. **SQLite 增加结构化 `TaskContractV1`，同时保留并派生现有 `goal / acceptanceCriteria / expectedOutput` 三字段**，旧任务和现有 Task Board 继续可用。
6. **第一次显式保存 `backlog` 时即建立主 Session 绑定**。绑定表示这段对话负责该 Task 的生命周期，不表示已确认或已授权执行。
7. **“确认并放入待办”只把 Task 写为 `ready`，不准备 Run、不发送 Prompt、不调用模型。**
8. **“确认并开始”是一个用户动作，但不是一个横跨 SQLite、Session JSONL 和 Pi SDK 的虚假“大事务”**。数据库步骤使用事务和幂等键；运行时步骤失败时补偿回 `ready`，绝不留下幽灵 `in_progress`。
9. **Run 保存确认时的合同快照**，执行 Agent 读取快照，不依赖之后可能变化的 Task 当前值。
10. 第一切片不加入独立复核、多 Agent、自动调度、非文件 Artifact 重构或跨模型调用。

## 2. 当前实现基线与缺口

### 2.1 已有能力

当前代码已经具备：

- SQLite 为 Task、Run、Review 和事件的权威来源；
- Task `version` 乐观锁；
- 一个 Task 只允许一个活动 Run；
- 一个 `primarySessionId` 只绑定一个 Task；
- `prepareTaskSession()` 对 Session 存在性、空闲状态和项目目录进行校验；
- `/start` 在创建 Run 失败时执行补偿；
- Run 失败或中断后 Task 回到 `ready`；
- Agent 只能通过 Run capability 读取 Task、请求用户输入和提交 Review；
- 用户验收与 Agent 权限分离。

### 2.2 主要缺口

当前“从对话整理为任务”仍然是表单流程：

```text
用户填写 title / goal / acceptanceCriteria / expectedOutput
→ 直接创建 ready Task
→ 准备 Session
→ 把执行 Prompt 预填到输入框
→ 用户再次发送后才开始 Run
```

这与已确认产品合同有六个差距：

1. Agent 没有先起草丰富任务约定；
2. 候选草案没有 Session 内持久表示；
3. 受众、权威来源、范围、约束、假设和未决问题无法结构化表达；
4. “保存草稿”“确认待办”“确认开始”没有完整分离；
5. 旧草案、版本冲突和失败恢复缺少对话内表示；
6. “确认并开始”仍需要用户再按一次发送，不是一个后果明确的用户动作。

## 3. 权威来源与状态边界

### 3.1 三类数据

| 数据 | 权威位置 | 含义 |
|---|---|---|
| 自由对话 | Pi Session JSONL | 用户与主 Agent 的探索和澄清 |
| 候选约定 | Pi Session JSONL 自定义条目 | 尚未被用户保存或确认的草案 |
| 已保存/已确认约定 | Pi Task SQLite | `backlog` 或 `ready` Task 的权威合同 |
| Run 执行合同 | SQLite Run 快照 | 本轮执行实际采用的合同 |

候选约定不是 Task 数据，因此放在 Session JSONL 不违反“Task 数据以 SQLite 为权威”的规则。候选草案一旦保存，SQLite 版本成为权威；Session 卡片只负责显示草案来源、提交结果和历史。

### 3.2 不增加 Task 业务状态

```text
Session candidate
  ├─ 保存草稿 ───────────────→ backlog
  ├─ 确认并放入待办 ─────────→ ready
  └─ 确认并开始 ─→ ready ─→ in_progress
```

“待决定”“待确认”“正在保存”“版本冲突”和“启动失败”是卡片或操作状态，不写入 `tasks.status`。

## 4. 结构化合同 `TaskContractV1`

### 4.1 数据形态

```ts
type ContractItemStatus =
  | "confirmed"
  | "agent_suggestion"
  | "assumption";

type ContractEvidenceRef = {
  kind: "user_message" | "project_file" | "project_rule" | "task" | "agent";
  label: string;
  ref?: string; // Session entry id、项目内相对路径或 Task id；不是任意外部凭据
};

type ContractItem = {
  id: string;
  text: string;
  status: ContractItemStatus;
  evidence?: ContractEvidenceRef[];
};

type ContractSource = ContractItem & {
  availability: "available" | "discover_during_run" | "not_applicable" | "missing";
};

type ContractDeliverable = ContractItem & {
  kind: "file" | "data" | "page" | "decision_record" | "external_action" | "other";
  suggestedPath?: string;
};

type ContractDecision = {
  id: string;
  question: string;
  blocking: boolean;
  status: "open" | "resolved";
  options?: string[];
  resolution?: ContractItem;
};

type ContractGate = {
  id: string;
  trigger: string;
  requiredAction: string;
  timing: "before_run" | "during_run" | "before_external_effect" | "before_review";
};

type TaskContractV1 = {
  schemaVersion: 1;
  title: string;
  outcome: ContractItem;
  audience: ContractItem[];
  authoritativeSources: ContractSource[];
  scope: {
    included: ContractItem[];
    excluded: ContractItem[];
  };
  deliverables: ContractDeliverable[];
  acceptanceCriteria: ContractItem[];
  constraints: ContractItem[];
  assumptions: ContractItem[];
  openDecisions: ContractDecision[];
  gates: ContractGate[];
};
```

### 4.2 设计理由

- `ContractItem.status` 直接支持“已确认 / Agent 建议 / 假设”的文字标记；
- “待决定”单独建模为 `openDecisions`，不与陈述混在一起；
- `evidence` 是可追溯线索，不宣称经过系统自动证明；
- 权威来源允许 `discover_during_run` 和 `not_applicable`，避免所有任务被迫伪造文件来源；
- `gates` 记录真实安装、删除、发送和发布等后续确认门，但不顺带建设工作流编辑器；
- 第一版保留非文件交付种类，但现有 Review 至少一个真实文件的限制暂不改变。

### 4.3 就绪判断由服务端重新计算

Agent 可以提出草案，但不能决定 Task 是否进入 `ready`。服务端至少检查：

1. 标题和 `outcome` 非空；
2. 至少一个交付项；
3. 至少一个可观察的验收项；
4. 权威来源至少有一个 `available`、`discover_during_run` 或 `not_applicable` 策略；
5. 没有 `blocking: true && status: "open"` 的决定；
6. 项目根目录和 Session cwd 关系通过现有真实路径校验；
7. 所有文本、数组数量、路径长度和总 JSON 字节数在限制内。

服务端返回检查列表和阻塞项，不返回容易误导的百分比评分。语义质量仍由主 Agent起草和用户确认，不能由字段存在性替代。

## 5. 兼容现有三字段

### 5.1 新合同到旧字段的确定性投影

每次保存结构化合同，在同一 SQLite 事务内派生：

```text
goal
  = outcome.text
  + 可选的受众/用途摘要

acceptanceCriteria
  = acceptanceCriteria[].text 的项目符号列表

expectedOutput
  = deliverables[] 的“名称/说明 + 建议路径”列表
```

这些字段继续服务于：

- 当前 Task Board 卡片与详情；
- 旧 API 客户端；
- 现有 `taskPrompt()`；
- 尚未改造的测试与导出。

投影函数必须纯函数、固定顺序、可单测。浏览器不能分别提交结构化合同和三字段，避免两份内容不一致。

### 5.2 旧 Task 的读取策略

迁移不把旧三字段伪装成“用户已确认的丰富合同”。

- 旧记录的 `contract_json` 保持 `NULL`；
- API 暴露 `contract: null` 和原三字段；
- 用户第一次进入“和 Pi 一起补全”时，适配器生成候选草案，并明确标记 `legacy_import`；
- 只有用户再次保存或确认后，才写入 `TaskContractV1`；
- 现有旧 `ready` Task 仍可执行，不因新规则被突然阻塞。

## 6. Session 候选草案格式

### 6.1 使用非上下文自定义条目

采用 Pi `SessionManager.appendCustomEntry()` / Extension `pi.appendEntry()`：

```json
{
  "type": "custom",
  "customType": "pi-task.task-framing",
  "data": {
    "schemaVersion": 1,
    "eventType": "draft",
    "draftId": "tfd_...",
    "revision": 2,
    "replacesEntryId": "abcd1234",
    "taskId": null,
    "baseTaskVersion": null,
    "contract": {},
    "changeSummary": ["确认比较基准", "物流费用改为单列"],
    "createdBy": "agent"
  }
}
```

原因：

- 自定义状态条目持久化但不参与 LLM context；
- 不把多版大 JSON 重复塞给模型；
- 不污染普通 assistant 文本；
- 可以沿用 Session 的分支和 entry id；
- 保存前仍明确属于候选状态。

### 6.2 事件联合类型

同一 `customType` 使用带版本的判别字段：

```ts
type TaskFramingSessionEventV1 =
  | { eventType: "suggested"; suggestionId: string; reason: string }
  | { eventType: "declined"; suggestionId?: string }
  | { eventType: "reopened" }
  | {
      eventType: "draft";
      draftId: string;
      revision: number;
      replacesEntryId: string | null;
      taskId: string | null;
      baseTaskVersion: number | null;
      contract: TaskContractV1;
      changeSummary: string[];
      createdBy: "agent" | "system_legacy_adapter";
    }
  | {
      eventType: "commit_receipt";
      operationId: string;
      sourceDraftEntryId: string;
      action: "save_draft" | "confirm" | "confirm_and_start";
      taskId: string;
      taskVersion: number;
      status: "succeeded" | "start_failed";
      message?: string;
    };
```

Session 条目不存 API token、Run capability、Provider 凭据或完整外部敏感数据。

### 6.3 分支、压缩和旧草案

Web 端增加独立投影器：

1. 按 `parentId` 取得当前 active branch；
2. 识别该分支上的 `pi-task.task-framing` 条目；
3. 将条目投影为仅供 UI 使用的 `CustomMessage`；
4. 最新草案完整显示，旧草案标记 `supersededBy` 并折叠；
5. 如果 Pi compaction 的上下文范围裁掉了最新草案，投影器仍从完整 active branch 恢复最新草案并放在当前历史末尾；
6. 切换 Session branch 时，草案随分支切换，不跨分支静默合并。

该投影不传给 `piBuildSessionContext()` 的模型消息，因此“显示在聊天里”和“参与模型上下文”保持分离。

## 7. 主 Agent 起草机制

### 7.1 核心 Framing Extension

新增可信内置 Extension，随普通 Pi Task Web Session 加载。它与执行期 `createTaskExtension()` 分开：

- Framing Extension：所有正常对话可用，只能建议和起草候选合同；
- Task Extension：仍只在准备好的 Task Session 中加载，只有活动 Run capability 才能执行 Task 工具。

### 7.2 工具边界

#### `suggest_task_framing`

- 只追加一次低压力建议状态；
- 当前 Session 已绑定 Task、已有未处理建议或已拒绝时返回不可建议；
- 不创建草案、不写 SQLite、不调用额外模型；
- 用户拒绝后追加 `declined`，本分支不再主动提示，除非用户显式重新打开。

#### `propose_task_contract`

- 输入 `TaskContractV1`、上一草案 entry id 和变化摘要；
- 服务端进行结构、大小和基本就绪检查；
- 使用 `pi.appendEntry()` 追加候选草案；
- 返回“候选草案已记录，尚未创建 Task”；
- 不持有 Task user mutation 能力；
- 当前 Task 有活动 Run 时拒绝修改合同，要求走暂停/恢复流程；
- Session 已绑定其他 Task 时拒绝创建第二份主合同。

### 7.3 每轮上下文注入

因为草案条目不进入模型上下文，Framing Extension 在 `before_agent_start` 中：

- 读取 active branch 最新候选草案；
- 注入一份隐藏、压缩后的“当前候选合同”；
- 明确标注哪些内容已确认、建议、假设和待决定；
- 只注入最新版本，不注入全部历史；
- 有权威 SQLite Task 时，优先注入 Task 当前合同，并说明未保存候选差异。

这仍使用当前主 Agent 的正常对话调用，不产生额外模型调用。

## 8. SQLite 变更

实施时在当前 schema 后增加一次增量迁移；在现有实验分支上预计为 `user_version = 3`。

### 8.1 `tasks` 新列

```sql
ALTER TABLE tasks ADD COLUMN contract_schema INTEGER;
ALTER TABLE tasks ADD COLUMN contract_json TEXT;
ALTER TABLE tasks ADD COLUMN contract_revision INTEGER NOT NULL DEFAULT 0;
```

规则：

- `contract_json IS NULL` 表示旧三字段 Task；
- 新合同首次保存时 `contract_revision = 1`；
- 以后每次合同正文变化同时递增 `task.version` 和 `contract_revision`；
- 仅队列移动或生命周期变化只递增 `task.version`。

### 8.2 `runs` 合同快照

```sql
ALTER TABLE runs ADD COLUMN task_version_at_start INTEGER;
ALTER TABLE runs ADD COLUMN contract_revision INTEGER;
ALTER TABLE runs ADD COLUMN contract_snapshot_json TEXT;
```

`beginRun()` 在同一事务内复制确认合同。执行期 `read_task` 和系统 Prompt 优先读取 Run 快照，Task 当前记录只提供状态、恢复说明和 Review 历史。

### 8.3 幂等操作表

```sql
CREATE TABLE task_framing_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_entry_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('save_draft','confirm','confirm_and_start')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'applying','saved','confirmed','awaiting_start','started','start_failed'
  )),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

同一个 `operationId` 重试时返回已有结果，不重复创建 Task 或 Run。操作表不取代 Task Event；Task Event 仍记录业务事实。

## 9. Session 主绑定

### 9.1 从自由对话形成 Task

- 候选阶段：只存在 Session 条目，不写 `primarySessionId`；
- 第一次“保存草稿”：创建/更新 `backlog`，并把当前 Session 设为 `primarySessionId`；
- “确认并放入待办”：创建/更新 `ready`，并绑定当前 Session；
- 绑定本身不准备执行 Extension、不创建 Run。

理由：显式保存后必须能从 Task 回到澄清对话，也必须阻止同一 Session 静默形成第二个主 Task。

### 9.2 从 backlog 进入“和 Pi 一起补全”

新增独立的 framing-session 准备路径，不放宽现有 `/prepare` 的“仅 ready”约束：

```text
POST /api/tasks/:id/framing-session
```

流程：

1. 校验 Task 为 `backlog` 或无活动 Run 的 `ready`；
2. 如果已有有效 `primarySessionId`，恢复原 Session；
3. 否则创建普通 Pi Session，成功后用乐观锁绑定；
4. 从 SQLite 合同或旧三字段适配出一条候选草案；
5. 不创建 Run、不加载 Run capability、不自动发送 Prompt。

Session 创建成功但数据库绑定发生版本冲突时，不覆盖其他窗口；新 Session 保留为普通对话，并向用户显示冲突。

## 10. API 设计

### 10.1 提交候选合同

```text
POST /api/task-framing/commit
```

请求只提交引用和用户意图：

```json
{
  "operationId": "tfo_...",
  "sessionId": "...",
  "sourceDraftEntryId": "abcd1234",
  "projectId": "prj_...",
  "taskId": null,
  "expectedTaskVersion": null,
  "action": "save_draft"
}
```

服务端必须：

- 校验浏览器 Origin；
- 回读真实 Session 和 active branch；
- 确认 `sourceDraftEntryId` 是当前分支最新草案；
- 从 Session 条目取合同正文，不信任浏览器合同 JSON；
- 校验 Session cwd 位于 Project root；
- 检查一个 Session 只能绑定一个 Task；
- 对已有 Task 使用 `expectedTaskVersion`；
- 对 `confirm` 和 `confirm_and_start` 重新计算 readiness；
- 在一个 SQLite 事务中写合同、兼容投影、状态、绑定、operation 和 Task Event。

### 10.2 查询当前 Framing 状态

```text
GET /api/task-framing?sessionId=...
```

返回：

- 当前 active branch 最新草案引用；
- 当前绑定 Task 及版本；
- readiness 检查；
- 可执行操作；
- 未完成或失败的 framing operation；
- 版本冲突时的服务端合同摘要。

### 10.3 Session 偏好事件

```text
POST /api/sessions/:id/task-framing/preference
```

只接受 `declined` 或 `reopened`，追加 Session 自定义条目，不写 Task。写入必须通过当前活 Session 的 SessionManager；不得在活跃 AgentSession 旁边另开一个 Manager 并并发追加同一 JSONL。

### 10.4 保留现有 API

- `/api/tasks`、`PATCH /api/tasks/:id` 继续支持旧三字段客户端；
- 新卡片只走 framing commit API；
- `/api/tasks/:id/prepare` 继续只接受 `ready`；
- `/api/tasks/:id/start` 的核心逻辑抽到共享 service，供旧流程和 Framing 启动意图复用；
- Agent 工具不调用任何浏览器用户 mutation API。

## 11. 乐观锁与冲突处理

提交时同时检查两层版本：

### 11.1 Session 草案版本

- `sourceDraftEntryId` 必须仍是 active branch 最新草案；
- 新草案的 `replacesEntryId` 必须指向上一版；
- 不满足时返回 `DRAFT_STALE`，保留本地草案并显示当前最新版；
- 不跨 Session branch 自动合并。

### 11.2 SQLite Task 版本

- 已保存 Task 必须提交 `expectedTaskVersion`；
- 不一致时返回 `VERSION_CONFLICT` 和最新 Task；
- UI 显示“服务器版本 / 当前草案”的字段级差异；
- 不采用 last-write-wins；
- 用户可以基于最新版重新生成草案、覆盖自己的未保存草案，或放弃。

建议新增错误码：

- `DRAFT_STALE`；
- `SESSION_ALREADY_BOUND`；
- `CONTRACT_NOT_READY`；
- `START_INTENT_EXPIRED`。

## 12. 三种用户操作的准确语义

### 12.1 保存草稿

```text
候选草案
→ SQLite 事务：upsert backlog + 绑定 Session + 记录事件
→ 尝试追加 commit receipt
→ 返回 backlog Task
```

不调用 `prepareTaskSession()`，不创建 Run，不发送 Prompt。

### 12.2 确认并放入待办

```text
候选草案
→ 服务端重新检查 readiness
→ SQLite 事务：upsert ready + 绑定 Session + 记录用户确认
→ 尝试追加 commit receipt
→ 返回 ready Task
```

不调用模型、不创建 Run。即使 Session receipt 写入失败，SQLite Task 仍是权威，页面刷新后从 Task 恢复已确认状态。

### 12.3 确认并开始

“一个用户动作”不等于“假装所有系统可放进一个事务”。采用可恢复编排：

```text
A. 同“确认并放入待办”，写出 ready Task
B. operation 进入 awaiting_start
C. 准备/恢复 Task Session
D. 客户端重连该 Session 的 SSE
E. 使用一次性 start intent 创建 Run
F. 自动发送可见用户消息：
   “我已确认任务约定并选择现在开始。请按该约定开始 Run 1。”
G. Prompt 接受后 Run 进入 running，operation 进入 started
```

用户只点击一次；步骤 C–G 是该点击触发的内部编排，不再要求用户按发送。

一次性 start intent 只保存在当前内存和 SQLite operation 中，不写 Session、日志或 URL。页面刷新后不自动恢复执行，必须再次由用户点击“现在开始”。

## 13. 启动失败与补偿

| 失败点 | SQLite 权威结果 | UI 恢复 |
|---|---|---|
| 合同提交前失败 | 无新 Task 变化 | 保留候选草案，可重试 |
| 合同已保存，Session 准备失败 | Task 保持 `ready` | 显示“已确认，启动失败” |
| Run 创建前页面关闭 | Task `ready`，无 Run | 不后台自动开始 |
| Run `starting` 后 Prompt 未接受 | Run `failed`，Task 补偿回 `ready` | 再次显式开始 |
| Prompt 已接受但响应丢失 | 通过 SSE、`GET /api/agent/:id` 和 Run 状态协调 | 不重复启动 |
| 应用重启时存在活动 Run | 沿用 `reconcileActiveRuns()` | Task 回 `ready`，保留恢复说明 |
| Session receipt 追加失败 | Task/Run 状态不回滚 | 从 SQLite 合成结果提示，可补写 receipt |

禁止行为：

- 因 Session JSONL 写入失败回滚已经确认的 SQLite Task；
- 把 `starting` 或浏览器 loading 当作已运行；
- 网络重试时重复创建 Task 或 Run；
- 页面刷新后使用旧 start intent 自动调用模型。

## 14. Task Event 与可审计性

新增或明确使用以下事件：

- `task.contract_saved`，actor=`user`；
- `task.contract_confirmed`，actor=`user`；
- `task.primary_session_bound`，actor=`user` 或 `system`；
- `run.start_requested`，actor=`user`，包含 `operationId` 和合同 revision；
- `run.starting` / `run.running`，actor=`system`；
- `run.failed` / `run.interrupted`，actor=`system`。

事件 payload 记录引用和变化字段，不复制全部合同或任何 capability。完整当前合同在 `tasks.contract_json`，本轮快照在 `runs.contract_snapshot_json`。

## 15. UI 集成点

### 15.1 新组件

```text
components/tasks/TaskContractCard.tsx
components/tasks/TaskContractCard.module.css
lib/task/contract.ts
lib/task/framing-session.ts
lib/task/framing-extension.ts
```

### 15.2 对现有消息流的改动

- `session-reader.ts` 只把指定 Framing custom entry 映射为 UI CustomMessage；
- `MessageView.tsx` 按 `customType` 渲染任务约定卡；
- `ChatWindow.tsx` 不把任务约定卡折叠进普通“过程详情”；
- 旧草案显示为轻量“已由草案 N 取代”；
- 卡片动作通过 AppShell 回调调用用户 mutation API；
- 保存/启动期间锁定重复动作，但正文保持可读；
- 阻塞决定的 `options` 渲染为原生按钮，经 ChatInput 的 `sendIfEmpty` 发送可见用户消息；不得从卡片直接调用 Task mutation 或外部操作；
- 对话忙碌时禁用选项；输入框已有草稿或工具关闭时保留原状态并显示就地反馈；
- 卡片继续使用 Pi Task 现有 CSS 变量、820px 对话列和 ChatWindow 滚动容器。

### 15.3 替换旧入口

当前顶部“整理为任务”按钮改为“一起把任务聊清楚”（Slice B 已实现）：

- 点击后通过正常对话发送一条可见用户意图；
- 主 Agent 在同一次普通调用中起草并调用 `propose_task_contract`；
- 不打开四字段空白表单；
- 后续单一工作目录减法切片已从 AppShell 移除 `TaskFromConversationDialog` 入口；组件源码暂留作历史兼容参考，不进入用户界面。

## 16. 权限与安全边界

1. Framing Agent 工具只能追加候选 Session 条目；
2. 保存、确认、开始只接受带同源浏览器请求；
3. 服务端从 Session 条目回读合同，不接受浏览器替换正文；
4. Project root、Session cwd 和真实路径继续使用现有 `realpath` 边界；
5. 候选合同不得包含凭据字段；文本和 JSON 总量设上限；
6. 当前 Session 忙碌时不提交合同或切换 Task 绑定；
7. 子 Agent 不加载 Framing user mutation，也不能确认合同；
8. `confirm_and_start` 不等于允许删除、安装、发送或发布；合同中的后续 gate 仍需再次确认；
9. 真实 Provider 与付费模型不进入自动测试，使用 faux Provider；
10. 全部验收数据继续使用 `.runtime/` 内隔离目录和虚构内容。

## 17. 实施切片

### Slice A：纯数据与 Session 投影（已完成并人工确认）

- `TaskContractV1` 类型、校验、readiness 和三字段投影；
- Framing Session event 解析；
- active branch、分支切换、compaction 恢复和旧草案折叠测试；
- 只渲染静态候选卡，不写 SQLite。

**退出条件**：真实 Pi Task 页面能从虚构 Session 条目稳定还原原型中的所有候选状态。

### Slice B：主 Agent 候选起草（已完成隔离验证）

- 全局可信 Framing Extension；
- `suggest_task_framing`、`propose_task_contract`；
- 最新草案上下文注入；
- active Run 和已拒绝 Session 的权限检查。

**退出条件**：faux Provider 在同一主 Session 生成候选草案；没有 Task、Run 或额外 Agent 调用。

验证结果：默认 RPC Session 已加载可信 Framing Extension；主 faux Agent 在一次正常工具循环中写入候选草案，下一轮只额外注入最新候选摘要；SQLite 未初始化，Task / Run / Delegation 均未产生。

### Slice C：保存与确认（已完成隔离验证）

- SQLite 增量迁移；
- rich contract、兼容投影和 operation；
- commit API、Session 绑定和版本冲突 UI；
- backlog / ready 状态及失败恢复。

**退出条件**：“保存草稿”和“确认并放入待办”后分别只有 `backlog` / `ready`，活动 Run 数均为 0。

验证结果：真实页面先写出同一 Task 的 `backlog`，再确认到 `ready`；两次操作均产生独立幂等 operation 和 Session receipt，最终 Task=1、Run=0、合同 revision=1、Task version=2。“确认并开始”仍保持禁用。

### Slice D：确认并开始（已完成隔离验证）

- 一次性 start intent；
- 自动可见用户消息；
- 复用并加强现有 prepare/start/compensation；
- Run 合同快照；
- 页面关闭、Prompt 失败和应用重启恢复。

**退出条件**：一次点击最多创建一个 Run；任何启动失败后 Task 为 `ready` 且无活动 Run。

验证结果：faux Provider 成功路径只创建一个 Run、只保存一条可见开始消息，并用确认时合同快照进入 Review；同 operation 重试不新增 Run。真实页面在事件流连接超时后把唯一 Run 收敛为 `interrupted`、Task 恢复为 `ready`、operation 写为 `start_failed`、活动 Run 为空并允许重试。程序化开始消息失败后不回填到输入框。完整广覆盖回归仍需在进入 Slice E 前补跑。

### Slice E：backlog 补全与旧流程收敛（已完成隔离验证）

- Task Board 为 `backlog` 和无活动 Run 的 `ready` Task 提供“和 Pi 一起补全”；
- 独立 Framing Session 路径创建或恢复普通 Pi Session，不放宽执行 `/prepare`；
- 旧三字段 Task 适配为 `system_legacy_adapter` 候选，并保留版本冲突保护；
- Task Board 展示 rich contract 摘要、readiness、权威来源、交付与验收；
- Slice E 当时继续保留旧字段编辑和旧创建表单；后续减法切片已移除新任务的旧创建表单入口，历史 Task 的旧字段编辑仍标注为回退。

验证结果：真实页面点击 legacy backlog 后，Task 保持 `backlog`、Run=0、活动 Run 为空；新 Session 只有 `session_info + draft`，用户与助手消息均为 0，输入框为空。rich contract 摘要在 1440px 与 390px 下无横向溢出。审查修正后最终常规回归 351 项及 4 项工作区兼容 Project Trust 测试通过。

### 单一工作目录减法切片（已完成隔离验证）

- 用户侧只显示当前工作目录；Project 选择、新建 Project 和新任务表单退出主界面；
- Task Board 自动匹配当前目录下最具体的兼容内部 Project；没有匹配时显示对话入口；
- 候选约定卡显示工作范围，用户保存或确认时才按需登记内部目录映射并写入正式 Task；
- 可写对话叠加简短通用工作纪律，侧边栏只显示 SDK 实际加载的规则路径与范围，不显示规则正文；
- 内部 `projects`、历史 Task、Run、Review 和 Session 数据结构不迁移。

验证结果记录在 `docs/handoffs/2026-08-15-single-workspace-core.md`；自动测试、Project Trust、生产构建和虚构真实页面均已通过，尚未合入或升级真实服务。

实现过程按 Slice 独立验收；由于原工作树没有保留每个 Slice 的完整源码快照，发布候选没有伪造逐 Slice Git 历史，而是拆为可独立构建验证的后端与 UI 两层提交。MoA 实验入口默认关闭，只有显式设置 `PI_TASK_ENABLE_READONLY_MOA=1` 才加载；Task Framing 观察期内不作为发布默认能力。

## 18. 验证矩阵

### 18.1 纯单元测试

- schema、大小、重复 id 和非法路径；
- readiness 的六类检查；
- rich contract 到三字段的固定投影；
- legacy Task 不被伪装为 rich contract；
- active branch、分叉、compaction 和 superseded 投影；
- `DRAFT_STALE` 与 `VERSION_CONFLICT`；
- operation 幂等重试。

### 18.2 Store 与 API 集成测试

- schema 迁移和旧库读取；
- 新 Task 保存为 backlog；
- 确认为 ready 且无 Run；
- 同 Session 并发创建只成功一次；
- stale Task version 不覆盖新版本；
- Run 快照与确认 revision 一致；
- 启动失败补偿回 ready；
- 跨 Project root、未持久 Session、忙碌 Session 被拒绝；
- 请求正文超过上限被拒绝。

### 18.3 Pi faux Provider

- 主 Agent 调用 `propose_task_contract`；
- 草案写入 Session 后刷新仍存在；
- 草案不作为普通 CustomMessage 进入模型历史；
- 下一轮只注入最新候选；
- 用户拒绝后不再建议；
- 子 Agent 无保存、确认或启动能力。

### 18.4 浏览器人工验收

使用代码、数据、报告和设计四类虚构任务，检查：

- 初稿、第二版、待确认、已存 backlog、已确认 ready；
- 保存失败、版本冲突、准备失败和启动失败；
- 长文本、窄屏、键盘和深浅主题；
- 底部操作始终可通过 ChatWindow 纵向滚动到达；
- “放入待办”不产生模型调用；
- “确认并开始”只产生一个可见 Run 起点。

### 18.5 隔离要求

所有自动和人工验收继续设置：

```text
HOME
TMPDIR
PI_CODING_AGENT_DIR
PI_TASK_DATA_DIR
```

到项目 `.runtime/` 子目录，只监听 loopback，只使用虚构数据。

## 19. 明确后置

本设计不解决：

- 非文件 Artifact 的最终权威模型；
- 设计任务的独立中间方向闸门对象；
- 独立复核者；
- 分域并行；
- 跨模型会诊；
- 自动调度和后台执行；
- Task 与多个平级主 Session 的关系；
- 对外发送、真实安装和发布授权。

这些能力必须在 Task Framing 真实使用稳定后分别设计，不能借本次 schema 变更顺带加入。

## 20. 实施前最终检查点

进入 Slice A 前只需再次确认两项：

1. 是否接受“第一次显式保存 backlog 时即绑定当前主 Session”；
2. 是否接受“确认并开始是一个用户动作、内部采用可补偿编排，而不是宣称跨 SQLite / JSONL / Pi SDK 的绝对原子事务”。

其余方案可按本文作为默认实现基线。
