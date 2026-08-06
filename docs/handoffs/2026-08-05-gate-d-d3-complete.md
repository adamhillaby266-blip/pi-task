# Pi Task Gate D — D3 完成与当前交接（2026-08-05）

> **后续状态：**Gate E 的 macOS 本机共享数据启动核心验收已通过；当前交接见 [`2026-08-05-gate-e-macos-local-complete.md`](2026-08-05-gate-e-macos-local-complete.md)。本文件保留 Gate D 的证据与边界。

## 当前结论

Gate D 的 D1（对话转任务/同 Session 恢复）、D2（人工输入、阻塞、取消）和 D3（合同维护、完整性提示、队列交互）均已完成实现与验收。

**仍未开始：**生产打包、发布、LAN 访问、调度、自动认领、多 Agent、工作流编辑与新的真实模型调用。D3 完成不等于可以开始生产打包。

## D3 已交付的行为

- `backlog` 与 `ready` 任务可编辑标题、目标、验收条件和预期产物；编辑以 `version` 做乐观并发校验。
- `ready` 任务必须有完整合同；缺少目标、验收条件或预期产物的任务只能留在 `backlog`，不能移入待办或交给 Pi。
- 每次实际合同变更都会写入 `task.contract_updated` 审计事件，并显示在任务详情。
- 桌面端支持原生拖拽跨列和同列排序；详情同时提供“移到待办 / 移回积压 / 上移 / 下移”，作为触控或无法拖拽时的确定性回退。
- D3 浏览器 fixture 只建立隔离虚构项目：`scripts/seed-gate-d-d3-browser.mjs`、`scripts/view-gate-d-d3.sh`。

## 验收证据

### 自动与隔离验证

2026-08-05 最终验证均通过：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

- 常规测试：207 passed。
- 隔离运行目录：`.runtime/gate-d-d3-final-smoke-20260805-223927/`。
- 虚构 fixture 页面返回 `200`；完整合同 PATCH 返回 `200`；过期版本返回 `409`；尝试把 `ready` 合同改为不完整返回 `400`。
- 隔离 `pi/auth.json` 为 `{}`；没有模型请求、公司资料或凭据。

### 真实浏览器验收

macOS 浏览器中，用户已完整操作并确认：

1. 不完整合同的缺项提示、编辑补全和移入待办；
2. 桌面端同列拖拽排序及状态移动；
3. `上移 / 下移 / 移到待办 / 移回积压` 的无拖拽回退；
4. 最终卡片视觉：首张卡片悬停不再被吸顶栏压住，静止状态描边更轻，悬停时仍有明确边界。

## 相关提交

- `e00c337 feat: add Gate D contract maintenance`
- `dba7f99 fix: add hover clearance above task cards`
- `b0cecd7 style: soften task card outlines`

D1/D2 的真实模型纵向验收权威证据仍在 `.runtime/external-gate-d-20260805-215735/result.json`；D3 没有重跑模型。

## 后续边界

若继续，请先单独确认下一阶段的受众、目标、发布方式与验收口径。特别是生产打包会涉及本地数据目录、升级/回滚、启动方式、平台兼容性与发布边界，不能把当前开发态浏览器验收直接当作生产就绪。
