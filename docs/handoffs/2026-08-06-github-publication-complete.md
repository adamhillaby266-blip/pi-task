# Pi Task — GitHub 公开源码首发完成（2026-08-06）

## 结果

Pi Task 已以新的干净源码历史发布到：<https://github.com/adamhillaby266-blip/pi-task>

本次只推送源码和文档；没有发布 npm 包、二进制、Docker 镜像、GitHub Release 或附件。

## 已发布边界

- 可见性：`public`；默认分支：`main`；
- 原有本地 `main` 的 39 个提交及其直接作者邮箱没有推送；公开仓库使用新的 GitHub noreply 身份创建干净源码历史；
- 继承的 `docs/screenshot2.png` 保留在本机原始检出中，但不在公开仓库；
- 保留当前 MIT 文本和 `UPSTREAM.md` 的 Pi Web 来源声明；
- Issues 已开启；Discussions 与 Wiki 已关闭；外部 PR 按 `CONTRIBUTING.md` 的 Issue 先行规则处理；
- GitHub Private Vulnerability Reporting 已开启，公开安全报告规则见 `SECURITY.md`；
- 启动器和 API Host 校验均拒绝非 loopback 主机，LAN/反向代理/公网部署仍不支持。

## 发布前与发布后验证

- 公开快照做了高置信度私钥、Token、Bearer 和带凭据 URL 扫描，未发现匹配；
- TypeScript、ESLint、启动/请求安全的针对性测试均通过；常规 Node 套件为 222 通过，另有 1 个已知父工作区 fixture 限制，4 个对应兼容用例通过；
- 文档本地链接、代码围栏与 diff 检查通过；
- 推送后已确认远端 `main` 与本地干净快照 commit 一致，仓库为 public、Issues=true、Discussions=false、Wiki=false、私密漏洞报告=true。

## 后续维护边界

公开仓库是本次创建的独立干净快照；原本地项目的 Git 历史没有被改写，也没有添加 remote。后续若要同步新改动，应先在公开仓库完成相同的敏感信息审计、文档验证和人工发布决定，不能直接推送原本地历史。
