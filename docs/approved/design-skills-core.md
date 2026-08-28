---
title: 统一 Agent Skill Catalog 与 CC Switch Skills Core
status: pending
approved_by: pending
risk_level: high
related_prs: []
related_commits: []
---

# 统一 Agent Skill Catalog 与 CC Switch Skills Core

## 裁决

本机 Skill 安装、启用、诊断与 runtime 链接的唯一长期 writer 是 **CC Switch Skills Core**（基于现有 `SkillService` 扩展）。

- **agent-skills**：catalog / provenance SSOT；不安装、不写 runtime 目录。
- **cc-switch**：中央库、activation、sync/doctor、runtime adapter。
- **dev-rules / Twin**：迁移期 legacy writer；稳定后 inactive 并删除写入路径。

## 产品承诺

用户在 CC Switch 里完成一件事：**看见技能库 → 选择 Agent → 启用 / 停用 → 看到真实诊断**。用户不需要理解各 runtime 的 skills 目录，也不手工维护 symlink。

一个事实只有一个 owner：

| 事实 | Owner |
| --- | --- |
| Skill 内容 | 真实 Git 作者源 |
| 共享 catalog、provenance、`recommended` | `agent-skills/skills.yaml` |
| 本机各 runtime 启用集合与接管意图 | CC Switch（SQLite + 可导出 JSON） |
| 已安装内容与 hash | `~/.cc-switch/skills/`（或用户选的 unified SSOT） |
| runtime 路径契约 | CC Switch adapter 表（单元测试固定） |
| 磁盘健康 | `cc-switch skills doctor` |

长期命令面（**当前 crate 无 bin**；v1 必须提供与桌面同一 Rust core 的 headless 入口，供 CI / dev-rules 调用。子命令、`--json`、exit code 以本节为契约；分发形态留给 Core 实现 PR）：

```bash
cc-switch skills sync [--check] [--runtime <id>] [--mode managed|legacy]
cc-switch skills doctor [--json]
```

桌面 UI（`UnifiedSkillsPanel`）与 headless CLI **必须调用同一 Rust core**。启动或浏览 UI **不得**隐式改变任何 runtime 的启用集合。

## 不做什么（v1）

- 不把 `~/.agents/skills` 建成全局 canonical active registry。
- 不要求所有 runtime 看到相同 active set。
- 不做 agent-side router、session attestation、immutable 多版本 Store。
- 不做 Project Skill 统一管理（`.cursor/skills` 等项目路径保持现有规则）。
- **不在 agent-skills 扩 install/sync CLI。**
- 不把 skills.sh / 硬编码 GitHub 仓库列表升格为 catalog SSOT（仅作补充发现源）。
- 不把 Claude Desktop / OpenClaw 纳入 v1 Skills managed（现网无可用 skill sync）。

## 现状与地基

本机仍有多套交叠 writer：

- **dev-rules** `sync.sh`：Cursor、Claude（经 cursor 整链）、Codex、Antigravity。
- **cc-switch**：`~/.cc-switch/skills/` → Claude/Codex/Gemini/Pi 等（逐 skill 链接）。
- **Twin**：`~/.twin/skills/twin` 及多个消费入口。

**正确动作不是重写，而是扩展 cc-switch 已有地基：**

- 中央库、`content_hash`、backup、`sync_to_app_dir`、foreign/collision 守卫；
- Skill × Agent 矩阵（DB `enabled_*`）；
- `scan_unmanaged` / `import_from_apps`；
- `migrate_storage`（`~/.cc-switch/skills/` ↔ `~/.agents/skills/`）。

缺口：catalog reader、Cursor/Antigravity adapter、managed/legacy 语义、ownership marker、headless CLI。

## 核心模型

```text
Git Skill Sources
        ↓ exact repo + commit + path
agent-skills catalog (skills.yaml)
        ↓ catalog reader
CC Switch verified library (~/.cc-switch/skills/<name>/)
        ↓ SQLite activation + runtime_adoption
per-runtime adapters (symlink / copy)
```

### Catalog 契约

沿用 [`agent-skills/schemas/skills.schema.json`](https://github.com/youxuanxue/agent-skills/blob/main/schemas/skills.schema.json)：

- `source.kind: self` → agent-skills 当前 catalog commit 内路径。
- `source.kind: git` → `repo` 必须为 **`https://github.com/.../*.git`**，`revision` 为 40 位 SHA。
- `recommended` 仅表示**首次 managed 接管**时的初始勾选建议，不是当前启用态。

示例（HTTPS，与 schema 一致）：

```yaml
schema: 1
skills:
  - name: xj-review
    recommended: true
    source:
      kind: self
      path: xj-review
  - name: twin
    recommended: false
    source:
      kind: git
      repo: https://github.com/youxuanxue/twin.git
      revision: "<40-char-sha>"
      path: skills/twin
```

description 从来源 `SKILL.md` 派生；catalog 不维护第二份 metadata。

### Verified library

默认 SSOT：`~/.cc-switch/skills/<name>/`（保留现有 `SkillStorageLocation` 设置）。

每条已安装 Skill 在 DB 标注 **provenance**：

| 类型 | 含义 |
| --- | --- |
| `catalog-managed` | 来自 agent-skills catalog；安装副本 UI 只读 |
| `local-draft` | 用户在本机创建/导入；可编辑；doctor 标为 unversioned |
| `bundled` | cc-switch 内置或历史安装、尚未纳入 catalog |

**同名冲突**：catalog 新条目不得静默覆盖 `local-draft` / `bundled`；hash 完全一致才允许原地提升为 `catalog-managed`，否则 fail closed。

catalog-managed 磁盘 drift：`sync` fail closed，提示真实 Git owner，不静默覆盖。

### Activation 与 runtime adoption

启用态 SSOT 是 **cc-switch SQLite**（现有 `skills` 表 + 扩展字段），不是独立 JSON 文件。可导出 JSON 供 CI / dev-rules 读取，但 SQLite 为权威。

扩展字段（示意）：

- `provenance`、`catalog_commit`、`source_kind`、`source_repo`、`source_revision`、`source_path`

新表 `skill_runtime_adoption`：

- `runtime_id`、`mode`（`managed` | `legacy` | `unsupported`）、`adopted_at`

**首次接管规则（修正旧 spec 漏洞）：**

| 场景 | 行为 |
| --- | --- |
| 全新机器 | 可用 `recommended` 生成**候选**初始 profile；UI 或 CLI **必须确认** |
| 已有 legacy | doctor 识别 dev-rules / Twin / cc-switch 旧装的 **active set**，作为候选 profile，展示 migration diff 后确认 |
| catalog 新增条目 | 默认**不启用**；不覆盖已有选择 |
| foreign entry | **永不**自动接管 |

`recommended` 只在 runtime **首次**进入 `managed` 时形成候选；确认后永不自动重放。

**Pi 裁决：接管后跟数据库。** 现网 Pi 是「文件夹在就是开、不在就是关」，数据库不记开关。未接管前保持这套老规矩。一旦进入 `managed`，改成跟别的 Agent 一样：CC Switch 数据库说开就开、说关就关；磁盘上有没有文件夹只是执行结果，不能再当第二本账。

### Runtime adapters

每个 runtime 独立处于 `managed` | `legacy` | `unsupported` 之一。一个 runtime 阻塞不阻止其它 runtime 接管。

**身份映射（禁止实现期再发明第二套枚举）：**

| 接管 token | 现有 `AppType` | 角色 |
| --- | --- | --- |
| `claude-cursor` | `Claude` + **新身份** Cursor | 原子耦合组；同启同停；`managed_runtimes` 只写此 token，不拆成 `claude`/`cursor` |
| `codex` | `Codex` | 已有 Skills runtime |
| `gemini` | `Gemini` | 已有；路径 `~/.gemini/skills`（Gemini CLI，不是 Antigravity） |
| `grokbuild` | `GrokBuild` | 已有 |
| `opencode` | `OpenCode` | 已有 |
| `hermes` | `Hermes` | 已有 |
| `pi` | `Pi` | 已有；接管后见上方 Pi 裁决 |
| `antigravity` | **新身份** | 新 adapter |
| — | `ClaudeDesktop` / `OpenClaw` | v1 **unsupported**（现网 skill sync no-op / `SkillApps` 永不启用） |

已有 runtime 的消费路径以 `SkillService::get_app_skills_dir` 为 SSOT，设计不再抄路径表。

**关键裁决：Claude + Cursor 耦合组 `claude-cursor`**

dev-rules 与 Cursor/Claude Code 的契约是：

```text
~/.cursor/skills/<name>  → SSOT/<name>     （additive registry，cc-switch-owned）
~/.claude/skills         → ~/.cursor/skills （整目录 symlink）
```

cc-switch 在 **managed** 模式下必须采用上述布局，**废弃**向 `~/.claude/skills/<name>` 逐 skill 写入的旧路径。矩阵中展示为一列「Claude + Cursor」。

**v1 新增 adapter 路径：**

| 接管 token | 消费路径 |
| --- | --- |
| `claude-cursor`（Cursor 侧） | `~/.cursor/skills/<name>` |
| `antigravity` | `~/.gemini/antigravity-cli/skills/<name>` |

**legacy import 扫描范围（首次接管）：**

- `~/.cursor/skills`、`~/.codex/skills`、`~/.gemini/antigravity-cli/skills`
- `~/.twin/skills/twin`
- 现有 cc-switch SSOT 与 `SKILLS_APP_IDS` 对应 runtime 目录

### Ownership marker

`~/.cc-switch/skills-control.json` 是 SQLite `skill_runtime_adoption` 的**生成物**（`sync` 重写，禁止手改）。给无法打开 SQLite 的 legacy writer 提供只读信号；「谁已被接管」的权威仍是 SQLite。

```json
{
  "schema": 1,
  "owner": "cc-switch",
  "catalog_ref": {
    "repo": "https://github.com/youxuanxue/agent-skills.git",
    "revision": "<40-char-sha>"
  },
  "managed_runtimes": ["claude-cursor", "codex"]
}
```

legacy writer 读到 marker 且自身 runtime 在 `managed_runtimes` 内（Claude / Cursor 均匹配 `claude-cursor`）时 **必须停止写入**。仅观察 symlink 不能证明 writer 已停用。

## 命令契约

### `cc-switch skills sync`

1. 解析 catalog 为精确 commit；校验 `skills.yaml`（可调用 `check_skill_catalog.py` 作 CI 契约）。
2. 按 source 安装/更新 SSOT；catalog-managed drift 时 stop。
3. 读 activation + runtime_adoption；生成 per-runtime target graph。
4. 全量预检（foreign collision、路径重叠、budget）通过后，再改链接。
5. 中断后重跑必须收敛；输出 managed/legacy/unsupported 摘要。

`--check` 只计算。`--mode managed|legacy` 必须与 `--runtime` 同用。`--runtime` 取值即上方身份映射表的接管 token。

### `cc-switch skills doctor --json`

只读报告：catalog revision、provenance 分类、profile vs 实际 adapter、foreign/broken/duplicate、legacy writer 是否 inactive、各 runtime skill 数量与 description 字符量、reload requirement。

任何阻止安全 `sync` 的问题 **exit 1**。`--json` 为 UI / CI / dev-rules 唯一机器契约；破坏性变更须提升 schema version。

## Legacy writer 过渡

| Provider | v1 角色 | 稳定后 |
| --- | --- | --- |
| dev-rules | inactive contract；marker 存在时 skip home skill 写入 | 删除 home/global skill writer |
| Twin | inactive；`twin` 走 catalog git 源 | 删除 runtime skill installer |

dev-rules **保留**项目 `.cursor/skills` 编辑入口与规则/sync；**删除**的是 home 层 skill symlink writer。

## 安全

- catalog 是共享 Skill 的信任边界；不从 runtime 目录自动提升进 catalog。
- external source 只接受 schema 允许的 HTTPS Git + 完整 SHA。
- 只删除可证明为 cc-switch-owned 的 managed link；foreign / real dir 不碰。
- bundle 大小、路径逃逸、断链与循环：沿用现有 `skill.rs` 守卫并补 catalog 路径。

## 跨仓库 PR 顺序

1. **本文件 merge**（cc-switch 审批基线）。**进 main 前** `approved_by` 必须从 `pending` 改为具体审批人名（R5）；禁止先合再翻转。
2. **agent-skills**：README 改 writer 声明为 cc-switch（纯文档）
3. **cc-switch Core**：catalog reader → DB 字段 → doctor/sync CLI → Cursor/Antigravity + claude-cursor → UI 接线
4. **dev-rules / Twin**：inactive contract（小 PR，绑定本 approved doc）
5. **逐 runtime cutover** → **删除 legacy writer**

不把 catalog、Core、legacy contract、fan-out 塞进一个 PR。

## v1 成功标准

- 用户在 CC Switch 完成 Library → 矩阵 → 诊断的完整旅程。
- 共享 Skill 有唯一 Git owner + catalog identity。
- SQLite activation 是本机启用态唯一 SSOT；symlink 与 `skills-control.json` 只是生成产物。Pi **接管后跟数据库**，不再用「文件夹在不在」当开关。
- 已有 legacy 机器首次接管导入 active set，而非静默缩成两个 `recommended` skill。
- foreign collision / catalog drift / writer overlap 在改链接前 fail closed。
- UI 与 `cc-switch skills` CLI 共享同一 core 与 `--json` 语义。
- managed runtime 上 legacy writer 机械证明为 inactive。

## 验证

- **单元测试**：catalog 解析、provenance 分类、身份映射 token、claude-cursor 布局、Pi 接管后开关跟数据库、managed/legacy 判定、foreign 分类、首次接管只应用一次 `recommended`。
- **集成测试**：clean-home 接管；legacy import；中断后重跑收敛；单 runtime legacy 不阻塞其它 runtime。
- **主机验收**：`cc-switch skills doctor --json` 对已 managed runtime exit 0；矩阵选择与 runtime discovery 一致。

---

**Supersedes：** 本地 ignored 稿 `2026-08-27-skill-ssot-design.md`。该稿不进入任何仓库主线；以本文件为唯一审批基线。
