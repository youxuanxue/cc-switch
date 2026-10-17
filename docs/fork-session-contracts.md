# Fork 会话特性保留契约

此文档登记会话特性的行为与 owner。上游可替换布局和组件，但不能让已交付的用户路径消失。验收必须从真实 UI 发起并断言结果；仅保留文件、import、词条或后端接口不算保留特性。

| 用户承诺 | 实现 owner | 验证 |
| --- | --- | --- |
| Codex 旧会话 provider 已缺失时，统一恢复命令显式使用当前有效 provider；刷新列表重算，保留仍有效的历史 provider，不改写会话文件 | `src-tauri/src/session_manager/providers/codex_resume.rs`；`codex.rs` 扫描缓存之后调用 | Rust `codex_resume::tests`、`resume_provider_refreshes_on_cache_hit_and_preserves_rollout`；`session-actions.spec.ts` 的 `@fork-session-codex-resume-provider` |
| 刷新、选择、清理、新建在列表页直接可达；新建使用所选应用、项目与工作区；无项目不启动 | `SessionManagerPage.tsx`、`NewSessionDialog.tsx`、`newSessionLaunch.ts` | `session-actions.spec.ts` 的 `@fork-session-actions`；`newSessionLaunch.test.ts` |
| 折叠项目可整组选取；搜索后只选当前匹配结果；取消删除不写数据 | `SessionManagerPage.tsx`、`sessionCapabilities.ts` | `@fork-session-actions` |
| 跨应用会话按物理项目归并，WTS 工作区回到主项目 | `sessions/utils.ts` | `session-project-view.spec.ts` 的 `@fork-session-projects`；`sessionUtils.test.ts` |
| 闲置清理经过 live 分类与二次确认，跳过运行中会话；探测失败禁止删除；空列表仍能进入存储清理 | `useSessionPrune.ts`、`SessionManagerPruneDialogs.tsx`、`StaleSessionCleanupDialog.tsx` | `@fork-session-live-cleanup`、`@fork-session-cleanup-probe-failure`、`@fork-session-empty-cleanup`；`check-session-live-ssot.mjs` |
| Cursor 恢复经过共享状态与专用 IPC | `useSessionCursor.ts`、`CursorResumeGate.tsx` | `cursor-official-sessions.spec.ts` 的 `@fork-session-cursor-resume`；`check-cursor-session-ssot.mjs` |
| 阅读、站内终端与已活跃会话复用共享 owner，保持一会话一活体 | `SessionReader.tsx`、`SessionReaderForkChrome.tsx`、`useSessionLiveTerminal.ts`、`liveTerminalSpawn.ts` | `check-session-chrome-ssot.mjs`、`check-session-live-ssot.mjs`；`SessionManagerPage.test.tsx`、`liveTerminalSpawn.test.ts` |

路径未带前缀时，实现位于 `src/components/sessions/`（阅读器位于 `reader/`）；浏览器用例位于 `tests/e2e/`，单测位于 `tests/components/`，检查脚本位于 `scripts/`。

## 执行门禁

`scripts/preflight.sh` 的前端检查开启 `CC_SWITCH_REQUIRE_FORK_CONTRACTS=1`，CI 的 `Frontend Checks` 复用同一入口。`tests/fork-contract-reporter.ts` 登记稳定的必测 ID，并检查真实运行结果。某条必测用例被删除、未收集、过滤、skip、标为预期失败或没有通过时，即使其余测试全绿，浏览器验收也非零退出。

本地仅运行会话契约：

```bash
CC_SWITCH_REQUIRE_FORK_CONTRACTS=1 pnpm exec playwright test tests/e2e/session-actions.spec.ts tests/e2e/session-project-view.spec.ts tests/e2e/cursor-official-sessions.spec.ts
```

## 上游合并裁决

- 合并前对照本表固定 fork 行为基线；先运行既有验收，再迁移 UI 适配。
- 重写页面时可以更新定位器，但必须逐项映射被删除/修改的行为断言到新用例，不能整份接受上游测试覆盖本地测试。
- 功能退役属于产品范围变更，不属于解冲突；没有明确退役决定时，保留承诺和必测 ID。
- 新增 fork 特性时同步登记行为、owner 和测试；涉及 UI 的核心路径加入必测 ID。

此门禁防止无意丢失和静默跳过，不证明断言永远正确。审查仍需核对测试是否被削弱，以及 gate/必测 ID 的变更理由；它也不替代原生 macOS 终端与文件系统的集成验证。
