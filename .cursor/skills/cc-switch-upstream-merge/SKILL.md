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

```bash
git fetch origin main
git fetch upstream main
node .cursor/skills/cc-switch-upstream-merge/scripts/audit.mjs
```

`audit.mjs` 生成固定 SHA、merge base、双方独有提交数、当前 PR 提交清单、fork
删除文件和 merge-tree 冲突结果。`dryRun.conflicts=true` 是冲突裁决输入；Git
查询错误会非零退出。该 helper 不更新分支或工作树。

## 冲突裁决

以下是判断残差，机械计数和验证由 helper / preflight 承载：

- **Skills Core**：以 `docs/approved/design-skills-core.md` 为基线。保持新控制面
  接线和 Claude / Cursor 独立 Agent。旧 `UnifiedSkillsPanel.tsx` 保持删除；
  评估上游修复是否需要移植到新组件。
- **Sessions**：保持一会话一活体、清理复用 live SSOT、物理项目路径聚合与 WTS
  工作区归并。已有三项 `scripts/check-*-ssot.mjs` 和 UI 验收由 preflight 执行。
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
node .cursor/skills/cc-switch-upstream-merge/scripts/audit.mjs
```

preflight 与 CI 共用入口，默认执行前后端全部检查；任一检查失败则非零退出。
不要用 `pnpm test:unit tests/` 代替全套测试，否则会遗漏 `src/` 中的测试。

PR body 使用中文 `摘要`、`风险`、`验证`、`提交` 小节。根据 audit 输出描述本次
上游内容和冲突裁决，列出全部提交及最新 HEAD；验证结果只写实际执行证据。
每次新增提交后重新生成。随后运行 `$xj-review`，跟踪同一 HEAD 的 CI 至终态。
