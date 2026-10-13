---
name: cc-switch-upstream-merge
description: >-
  Import or review farion1231/cc-switch upstream/main changes in the
  youxuanxue/cc-switch fork while preserving Skills Core, Sessions lifecycle,
  and TokenKey Gemini behavior.
---

# CC Switch upstream merge

基于 `agent-skills` 的 [upstream-merge SOP](https://github.com/youxuanxue/agent-skills/blob/main/upstream-merge/SKILL.md)，本 skill 仅承载 CC Switch 专属的不变量与验证门禁。

在 `merge/upstream-*` 分支合入上游。用非快进 merge 保留 fork 历史；不 rebase
已发布历史、不强推。合并 PR 与发布仍遵循用户授权。

## 准备与机械证据

创建或切换工作区使用 `$git-worktree-submodule` 的 `wtree.py`，绑定
`session-workdir` 并通过 `session-check` 后再读写。已有用户改动按归属保留。
沿用仓库配置的 remote，不改写地址。

先加载通用 `upstream-merge` skill，按其 §1 解析 `UPSTREAM_AUDIT`、fetch 并固定
`FORK_BASE` / `UPSTREAM_TARGET`，运行通用审计，读取 fork 与测试变更证据。
`dryRun.conflicts=true` 是冲突裁决输入；无文本冲突也必须核对行为保留基线。

## 冲突裁决

以下是判断残差，机械计数和验证由 helper / preflight 承载：

- **Skills Core**：以 `docs/approved/design-skills-core.md` 为基线。保持新控制面
  接线和 Claude / Cursor 独立 Agent。旧 `UnifiedSkillsPanel.tsx` 保持删除；
  评估上游修复是否需要移植到新组件。
- **Sessions**：先读 [会话特性保留契约](../../../docs/fork-session-contracts.md)，
  按其中的行为、owner 与必测 ID 裁决。preflight 同时检查 SSOT 和 UI 旅程实际通过；
  文件仍在或编译通过不能替代入口可达。迁移测试必须保留行为断言，不能以适配上游
  布局为由删除特性及其验收；退役按契约中的产品范围变更处理。
- **TokenKey / Gemini**：保留原生模型发现端点与解析契约；新增厂商预设不能覆盖
  fork 的 provider 行为。
- **词条和入口**：保留 fork 的 skills / sessions / tokenkey 接线与翻译，同时吸纳
  上游新增内容。非上述冲突面的上游功能默认保留。

先完成上游 merge 与冲突处理；需要恢复不变量时另作聚焦修复提交。
只有实际降低后续冲突成本时才提取 facade / companion。

## 验证与 PR

依赖已安装且 Playwright Chromium 可用后，在当前工作树执行：

```bash
bash scripts/preflight.sh
node "$UPSTREAM_AUDIT" --base "$FORK_BASE" --upstream "$UPSTREAM_TARGET" --head HEAD
```

preflight 与 CI 共用入口，默认执行前后端全部检查；任一检查失败则非零退出。
不要用 `pnpm test:unit tests/` 代替全套测试，否则会遗漏 `src/` 中的测试。

PR body 使用中文 `摘要`、`风险`、`验证`、`提交` 小节。根据 audit 输出描述本次
上游内容和冲突裁决，列出全部提交及最新 HEAD；验证结果只写实际执行证据。
每次新增提交后重新生成。随后运行 `$xj-review`，跟踪同一 HEAD 的 CI 至终态。
