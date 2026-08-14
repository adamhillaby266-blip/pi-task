# Task Framing 发布候选交接

> 日期：2026-08-14
>
> 分支：`release/task-framing-candidate`
>
> 基线：`40bb839`（Pi SDK 0.84.1）
>
> 状态：代码审查、修正、分层提交与隔离回归完成；尚未合并、安装、接入真实数据或发布

## 1. 当前目标

先把 Task Framing 发布候选用于维护者本机升级，在完整备份和可回滚前提下接入现有 Pi Task 数据，观察 1–2 天；确认数据库迁移、既有 Session、Task/Run/Review 和新任务约定流程稳定后，再决定公开发布。

公开发布前不删除旧三字段表单。MoA 只读委派保留为实验实现，默认关闭；只有显式设置 `PI_TASK_ENABLE_READONLY_MOA=1` 才加载入口，不进入本轮内部试用和公开发布的默认能力。

## 2. 发布候选提交

- `40bb839 chore: upgrade Pi SDK to 0.84.1`
- `b811e29 feat(task): add durable framing and opt-in readonly delegation`
- `7bd7ca4 feat(ui): add task agreement workflow`
- `579a9a5 docs: record task framing release candidate`
- `363d994 fix(upgrade): back up Task data before migration`

原工作树没有保留 Slice A–E 各自的完整源码快照。为避免伪造不能独立构建的逐 Slice 历史，候选按可验证层拆为后端与 UI 两个提交；每层均从 Git index 导出独立源码树验证。

## 3. 独立审查修正

在 Slice E 完成态基础上补充修正：

1. `/api/tasks/:id/start` 先验证 start intent 归属，失败时不会把其他 Task 的 operation 标成 `start_failed`，也不会清除无关 Session binding；
2. `start_failed` 仍视为合同已保存、已确认，只开放“重试开始”，不会重新开放保存草稿或确认按钮；
3. readiness UI 按全部未通过检查计数；没有 open blocking decision 但来源、交付或验收缺失时，不再误显示“已足够安全地开始”；
4. worktree Session 创建 Task Project 时使用真实 Session cwd，不误用逻辑主仓库根目录；
5. Task 启动 API 失败会清理浏览器 pending start 状态，并保留可见错误与状态刷新路径；
6. confirm-and-start 在启动响应不确定时预先保留 operation intent，可通过补偿 API 收敛；
7. 数据库拒绝高于当前支持版本的 schema，不把未来数据库静默改写为 v3；
8. MoA 默认关闭，避免在 Task Framing 观察期提前产品化。

## 4. 验证结果

最终源码状态：

- 常规测试：353 项通过；
- 当前工作区可成立的 Project Trust：4 项通过；
- TypeScript：通过；
- ESLint：通过；
- `git diff --check`：通过。

分层提交验证：

- 后端 index 独立导出：341 项通过，TypeScript 与 ESLint 通过；
- 后端 + UI index 独立导出：351 项通过，Project Trust 4 项通过，TypeScript 与 ESLint 通过；
- macOS arm64 E2 隔离生产构建与页面冒烟通过：HTTP 200、`auth=absent`、未提升到 `.next`；
- 新增 Task 数据升级保护：显式停服确认、SQLite 一致性备份、v1 原件保持不变、独立副本迁移到 v3、完整性与权威行数回读均通过虚构数据测试。

仍只有既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。此前 Slice E 的 1440px、390px 页面与 SQLite/Session 隔离证据继续有效；审查后新增的 readiness 分支已通过服务端静态渲染测试。

## 5. 恢复与来源保护

原始混合工作树继续保留在：

```text
pi-task-worktrees/upgrade-pi-sdk-0.84.1/
```

审查前恢复快照：

```text
.runtime/recovery-review-20260814-225959/
```

审查后、拆分前完整快照：

```text
.runtime/reviewed-source-20260814-231614/
```

后者包含 tracked binary patch、36 个未跟踪文件归档、文件清单与 SHA-256 校验。发布候选 worktree 与该快照的 tracked patch 和未跟踪文件哈希已核对一致。

## 6. 下一阶段门

下一阶段仍不直接覆盖当前安装，应按顺序执行：

1. 在隔离目录做生产构建与安装前检查；
2. 识别当前安装版本、服务状态和真实数据目录，只读盘点，不先迁移；
3. 停止写入前确认 Agent/Run 空闲；
4. 使用升级器在停服状态通过 SQLite backup API 制作带 SHA-256 的一致性 Task 数据备份；
5. 升级器在独立副本上执行 v1 → v3 迁移，检查 `integrity_check` 与 projects/tasks/runs/artifacts/reviews/events 行数；该路径已用虚构 v1 数据验证，尚未对真实数据执行；
6. 先以前台隔离方式运行候选并验证既有 Session、Task、Run、Review 与 Task Framing；
7. 向维护者报告备份、迁移结果、回滚命令和影响，取得明确确认后才更新当前安装；
8. 本机试用 1–2 天，记录异常和旧字段回退使用；
9. 再单独执行公开仓库审计、发布说明、干净构建和发布确认。

未经再次确认，不操作当前安装、LaunchAgent、真实数据迁移、公开仓库或发布渠道。
