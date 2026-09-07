---
name: cc-switch-upstream-merge
description: >-
  CC Switch upstream merge workflow for importing farion1231/cc-switch upstream/main. Use when merging or reviewing upstream drift, preparing an upstream merge PR, or maintaining recurring upstream update discipline.
---

# CC Switch upstream merge SOP

适用于 `merge/upstream-*` 分支。用于将上游官方仓库（`farion1231/cc-switch`）主线合入当前 fork 仓库（`youxuanxue/cc-switch`），并严格守卫本仓库的核心特性与架构不变量。

## 确定性基线（机械化 vs 真判断）

按 dev-rules 确定性基线规范：本 skill 绝大多数是真判断（架构不变量、commit 形状、冲突裁决），机械化部分集中在准备、dry-run 探测与质量验证。

| 步骤 | 类型 | 承载 |
|---|---|---|
| upstream drift 探测 / fetch / merge-tree dry-run | 机械 | `git fetch upstream` + `git merge-tree --write-tree origin/main upstream/main` |
| 前端构建与测试（React/TS） | 机械 | `pnpm build` + `pnpm test` |
| 后端构建与测试（Tauri/Rust） | 机械 | `cargo check --manifest-path src-tauri/Cargo.toml` + `cargo test --manifest-path src-tauri/Cargo.toml` |
| 代码格式校验 | 机械 | `pnpm prettier --check .` + `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |
| Commit 形状（Harness / Invariant / Refactor） | 判断 | 人工 / Agent 架构区分 |
| 冲突裁决与不变量守护 | 判断 | 遵循 §1 不可逾越原则与 §3 决策清单 |
| Red flags 拦截 | 判断 + 机械 | 遵循 §7 Red flags |

---

## 0. 流程心智

1. **绝对禁止 `git rebase` 与强制推送 `push -f`**：
   Fork 仓库的 `origin/main` 拥有独立维护的历史提交（PR 链条与 commit SHA）。必须使用 `git merge --no-ff` 保留已合并的历史节点与可追溯性。
2. **合并由人/Agent 手动主导，禁止 CI 无人值守自动合入**：
   Upstream merge 涉及业务不变量判断，严禁在 CI 中做无人工复核的自动 merge 或向 main 自动发版。
3. **隔离分支验证**：
   所有 upstream merge 均在 `merge/upstream-YYYYMMDD` 分支上完成全部解冲突、编译与回归验证后，再以 PR 或 fast-forward / merge 方式合回 `main`。

---

## 1. 不可逾越原则（Invariants）

每次 upstream merge 都必须严格守卫以下核心资产：

1. **Skills Core 控制面不可退让**：
   - 本仓库已将技能系统彻底重构为 Skills Core 控制面（#6, #8, #9, #10 等）。
   - 上游若对已废弃的旧组件（如 `src/components/skills/UnifiedSkillsPanel.tsx`）进行修改（如无障碍 a11y 修补），**一律保持删除（git rm）**，不得让旧组件复活。
   - 保持 Claude Code 与 Cursor 拆分为两个独立在用 Agent 的架构设计。
2. **Sessions 活体会话与生命周期 SSOT 不可破坏**：
   - 站内内置 PTY 终端必须维持「一会话一活体」机械门禁，多 holder 时优先外置终端（如 iTerm）。
   - 闲置清理与跨工具清理必须**强制复用 live SSOT**，坚决禁止误删活跃 Cursor/Claude/Codex 会话和项目桶。
   - 会话列表必须继续按物理真实项目路径聚合，WTS 工作区合并到同一仓库上下文。
3. **TokenKey / Gemini 定制契约不可覆盖**：
   - Gemini 支持 TokenKey 原生模型列表接口等本仓库特有能力，不得被 upstream 的默认 provider 预设覆盖冲掉。
4. **最小 upstream 冲突面**：
   - 最大化吸纳 upstream 新增的官方厂商预设（如 Tencent TokenHub, 9527CODE, AICodeWith, QwenCloud 等）与最新模型定价（GLM-5.3, GPT-6 Astra, Gemini 3.8 Flash 等）。
   - 非不变量相关的 upstream 修复（a11y, proxy 工具增强等）默认全量保留。

---

## 2. 准备流程

1. **确保工作区干净**：
   ```bash
   git status
   # 若有未跟踪或未暂存文件，先 stash 或确认归属
   ```
2. **同步远端分支**：
   ```bash
   # 配置 SSH 地址（如 HTTPS 连接 GitHub 存在网络受限）
   git remote set-url upstream git@github.com:farion1231/cc-switch.git
   git fetch origin --tags
   git -c core.sshCommand=/usr/bin/ssh fetch upstream --tags
   ```
3. **Dry-run 冲突推演**：
   ```bash
   git merge-tree --write-tree origin/main upstream/main
   # 提前识别潜在冲突文件，特别注意 modify/delete 类型的冲突
   ```
4. **切出对齐分支**：
   ```bash
   git checkout -b merge/upstream-$(date +%Y%m%d) origin/main
   ```

---

## 3. Commit 形状（三类提交）

为保证 PR 历史清晰可追溯，upstream merge 分支上的提交严格拆分为三类：

### A. Merge Harness Commit
* **操作**：
  ```bash
  git merge --no-ff upstream/main -m "chore(upstream): merge upstream/main into merge/upstream-YYYYMMDD"
  ```
* **职责**：
  - 纯粹解决 git 冲突，接入上游带入的新模型、新预设与新修补。
  - 解决已被重构替代的遗留文件冲突（如删除旧 `UnifiedSkillsPanel.tsx`）。
  - 保证项目基础代码可编译（编译不报错）。
* **严禁**：顺风车借机重构不相干逻辑，或私自删除 upstream 正常功能。

### B. Invariant Commit
* **职责**：专项修补因 upstream 合入被意外冲刷的核心不变量：
  - 恢复 Skills Core 组件与在用 Agent 状态。
  - 校验 Sessions `live SSOT` 会话防误删逻辑与内置 PTY 路由。
  - 校验 Gemini TokenKey 接口端点与模型解析契约。
  - 恢复多语言文案中被冲掉的本仓库专属 i18n 词条。

### C. Convergence / Refactor Commit（如有）
* **职责**：若本次 upstream 大幅修改了热点文件导致本仓库改动分叉过大，收敛并提取为 facade/companion，降低下一次 merge 的冲突面。

---

## 4. 冲突决策清单

当合并遇到冲突或 upstream 新能力时，按以下优先级决断：

1. **是否属于本仓库已废弃重构的文件？**
   - 典型：`src/components/skills/UnifiedSkillsPanel.tsx`。
   - 裁决：**保留删除**（`git rm`）。若 upstream 的改动是关键 bug 修复或 a11y 属性，评估是否需要在新的 Skills Core 组件（`SkillsCorePanel` 等）中同步补齐。
2. **是否属于多语言词条（locales/*.json）？**
   - 裁决：保留 upstream 新增的 key，同时坚决保留 fork 仓库新增的 sessions/skills/tokenkey 相关翻译，做并集处理。
3. **是否属于路由或应用入口（`src/App.tsx`）？**
   - 裁决：确保 Skills 面板依然挂载在新的 Skills Core 控制面，Tandem/Sessions/Terminal 入口保留。
4. **是否属于官方新增厂商预设或模型定价？**
   - 裁决：**默认全量吸纳**。

---

## 5. 标准检查清单（质量门禁）

在合并分支推送到远端或合入 main 前，必须全部通过以下本地质量验证：

- [ ] **前端类型检查与打包**：
  ```bash
  pnpm build
  ```
- [ ] **前端单元测试**：
  ```bash
  pnpm test
  ```
- [ ] **前端代码格式**：
  ```bash
  pnpm prettier --check src/
  ```
- [ ] **Rust 后端语法检查**：
  ```bash
  cargo check --manifest-path src-tauri/Cargo.toml
  ```
- [ ] **Rust 后端单元测试**：
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml
  ```
- [ ] **Rust 代码格式**：
  ```bash
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  ```
- [ ] **无未说明的文件删除**：
  ```bash
  git diff --diff-filter=D upstream/main..HEAD --
  ```

---

## 6. PR Body 模板与变更摘要

```markdown
## Summary
- Merge upstream/main into fork main preserving Skills Core, Sessions SSOT, and TokenKey invariants.
- Upstream brought-in: <N> commits (including Tencent TokenHub, GLM-5.3, GPT-6 Astra, Gemini 3.8 pricing, Codex image proxy).

## Invariants Guarded
- [x] Skills Core control plane remains active (dropped legacy UnifiedSkillsPanel).
- [x] Sessions live SSOT and single-live-instance gate preserved.
- [x] TokenKey Gemini model discovery intact.

## Validation
- `pnpm build` passed
- `pnpm test` passed
- `cargo check --manifest-path src-tauri/Cargo.toml` passed
- `cargo test --manifest-path src-tauri/Cargo.toml` passed

## Audit
- Merge Base: <merge_base_hash>
- Fork ahead count: `<git log --oneline upstream/main..HEAD | wc -l>`
- Top modified files: `<git diff --stat upstream/main..HEAD | head -10>`
```

---

## 7. Red Flags（绝对禁止项）

1. **严禁 `git rebase upstream/main`**：破坏原有 commit hash，导致已有 PR 索引失效。
2. **严禁 `push -f` 到 `origin/main`**。
3. **严禁复活已被重构删除的旧组件**（如误把 `UnifiedSkillsPanel.tsx` 重新作为有效代码提交）。
4. **严禁跳过验证命令（`--no-verify`）**。
5. **严禁丢失 fork 专有能力**（Sessions 活体保护、内置 PTY、TokenKey 适配）。
