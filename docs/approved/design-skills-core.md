---
title: 统一 Agent Skill Catalog 与 CC Switch Skills Core
status: shipped
approved_by: feng
risk_level: high
related_prs: ["https://github.com/youxuanxue/cc-switch/pull/6", "https://github.com/youxuanxue/cc-switch/pull/9"]
related_commits: ["12e13692097c79970a6547c7f4a20bb9ff935522", "ff0d8a5dd30b8dd05688f36cce4d4b06ab146b1f"]
---

# 统一 Agent Skill Catalog 与 CC Switch Skills Core

本文件是施工图，读者是下一个作者。合上它做成的事：开工不会发明第二个 writer、第二本账、第二把开关。桌面可视化是 Core 实现 PR 的产品，不是本文件的验收。

## 裁决

本机 Skill 的唯一长期 writer 是 **CC Switch Skills Core**（扩展现有 `SkillService`）。

体系是控制面：**本机各 Agent 共用一份技能。** CC Switch 是旋钮和屏幕。

- **agent-skills**：catalog / provenance（货架）；不安装、不写 runtime 目录。
- **cc-switch**：中央库（工作台）、在用 Agent 名单、sync / doctor、runtime adapter。
- **dev-rules / Twin**：迁移期还会写家目录；稳定后停写并删除写入路径。

一句话：**库里有的，所有在用 Agent 都必须有；否则这笔装/卸不算成功。**

## 主线

**一份内容。** 技能文件只在中央库有一份（默认 `~/.cc-switch/skills/<name>/`，保留现有 `SkillStorageLocation`）。各在用 Agent 只拿链接或等价投影。

**一把开关，开关就是库。** 没有「装着但关掉」。进库 = 放到工作台 = 所有在用 Agent 看见。出库 = 卸下。效率靠管库（装/卸），不靠静音。Catalog 可以很大；**同步 catalog ≠ 把货架未入库的条目装进来**。

**进库不看来源。** 货架装、本机自建、导入（含现有 `import_from_apps`）、第一次确认的现场，都是进工作台，立刻投影到全部在用 Agent；一批一笔，半截不留。provenance 只有两种：从货架 `install` 进来的才是 `catalog-managed`（跟总闸换版）；其余一律 `local-draft`（不跟）。第一次确认不对 hash、不偷偷升成货架件。没有第三态 `bundled`。

**改 `local-draft` 就是改工作台。** 存盘立刻再投影到全部在用 Agent。写不齐：整笔失败，库里那份回滚到存盘前，不留下半截改。这是改内容，不是第二把开关。`catalog-managed` 仍只读；磁盘被改脏走既有 fail closed，不走这条编辑路径。

**货架换版：一把总闸「自动同步」，默认打开。** 不是按技能各开各的。

- **开（默认）**：`sync` 把库里已有的 `catalog-managed` 对齐到当前货架 revision，再投影到全部在用 Agent。这一轮要对齐的更新是**一笔**；任一技能或任一在用 Agent 失败，整笔回滚，库成员与副本 revision 都不变。
- **关**：钉死。货架走了只在 doctor 报「有新版」；换版必须显式 `upgrade`，同样整笔失败则不换。
- 副本被人改脏（和入库 revision 对不上）：两种模式都 **fail closed**，不静默覆盖。

**在用 / 不用。** 没有 `managed | legacy | unsupported` 三态主模型。

- **在用**：进门，共这一把开关；写不齐，整笔失败。
- **不用**：门外，控制面不理。v1 接不住的（Claude Desktop / OpenClaw）默认不用。

分头进门：可以先只用一部分 Agent。进了就必须共库。没有「在用但还按老规矩」的第三态。

**去掉最后一个在用 Agent = 关张。** 停写、清空 marker、在用名单为空、**库成员账清空**（SQLite 不再有工作台）。**不拆**已经投影到各 Agent 目录的链接——关张是停写清账，不是卸库。磁盘上的旧库目录可以留着，但是文件，不是开关、不是候选源。再开张仍按第一次：只从已勾 Agent 目录出候选（目录里还在的链接算现场，照常提）；不把旧库名单端出来，也不因 `~/.cc-switch/skills/` 还在就跳过 `recommended`。要用旧库文件而目录里已经没有的，走 `import` 或从货架再装。禁止「至少留一个在用」这种特殊态。

**第一次：先定在用 Agent，再确认工作台。不自动倒库。**

1. 人先勾这台机器**在用哪些 Agent**（v1 接不住的不出现）。默认**全不勾**；探测到目录里有东西的只标「看见过」，不预勾。看见过 ≠ 在用。确认前不改链接。**一个都不勾 = 控制面未开张**：不写 marker、不碰磁盘、不建空库；下次再来仍是第一次。**未开张（在用名单为空，含关张后）时，只有 `open` 可以写库。** `agents add` / `init` / `bootstrap` 都不是开张，零个在用 Agent 上的 `install` 也不算「全部写齐」。
2. 再出技能候选，两份不混：

| 场景 | 候选从哪来 |
| --- | --- |
| 已勾的在用 Agent 目录里已有技能 | 只提这些目录里**已经在用的**；不把 catalog `recommended` 混进来。每个 token 只扫自己的投影根 |
| 同时勾了 `claude` 与 `cursor`，同名同 hash | 算一份候选；两边各自投影到同一中央库 |
| 已勾目录里同名内容不一致 | **整笔停**；标冲突，不替人挑 |
| 已勾的在用 Agent 都是空的（空机器） | 只用 catalog `recommended` |
| catalog 后来新增 | **不进库**，除非人再装 |
| 关张后留下的旧库目录 | **不当候选**；不自动进工作台 |
| 关张后 Agent 目录里还在的链接 | **算现场**；已勾则按「已经在用」提 |
| 外来物（foreign） | **永不**自动进库、不删 |

确认进库时：现场一律 `local-draft`（不对 hash、不升格）。空机器确认的 `recommended` 从货架来，标 `catalog-managed`。已勾目录里**同名内容不一致**（hash 不同）：整笔停，控制面不替人挑；人处理完再确认。确认工作台之前不改任何 runtime 链接。浏览 UI 不得隐式改库或在用名单。

**后来入伙。** 只在已开张时。对齐当前库才能进门：库里缺的必须补上，否则入伙失败。它自己多出来、库里没有的，当外来物，不碰。未开张不能靠 `agents add` 绕过 `open`。

**Pi。** 未在用：保持现网「文件夹在就是开」。一旦在用：磁盘只是库的投影，不再当第二本账。

## 一个事实一个 owner

| 事实 | Owner |
| --- | --- |
| Skill 内容 | 真实 Git 作者源 |
| 货架（catalog / provenance / `recommended`） | `agent-skills/skills.yaml` |
| 工作台（库里有哪些） | CC Switch SQLite（可导出 JSON；SQLite 为权威） |
| 这台机器在用哪些 Agent | 同上 |
| 货架换版是否自动跟上 | 同上（总闸，默认开） |
| 已装副本与 hash | 中央库目录 |
| runtime 路径 | adapter 表。现网默认以 `SkillService::get_app_skills_dir` 为 SSOT；`cursor` 为 `~/.cursor/skills/<name>`；`claude` 为 `get_app_skills_dir(Claude)` 下逐条投影 |
| 磁盘是否与库一致 | `cc-switch skills doctor` |

## 不做什么（v1）

- 不按 Agent 各开各的；不做技能 × Agent 启用矩阵。
- 不把 `~/.agents/skills` 建成全局 active registry。
- 不做 agent-side router、session attestation、immutable 多版本 Store。
- 不做 Project Skill 统一管理（项目内 `.cursor/skills` 保持现有规则）。第一次只确认公共工作台；项目专用技能等 CC Switch 有项目概念后再做。
- 第一次候选不把指向 `~/.codeg/skills` 的现场当已用项（CodeG 还不是在用 Agent，那些链接是另一套账）。
- 不在 agent-skills 扩 install / sync CLI。
- 不把 skills.sh / 硬编码 GitHub 仓库升格为货架或工作台；只保留现有发现入口并冻结。
- 不把 Claude Desktop / OpenClaw 列为在用。
- 不把整个 catalog 倒进库。
- 不给每个技能单独设「自动同步」；只有总闸。
- 不给本机自建 / 导入另开一套投影规则或「先入库、稍后同步」。
- 不把 `local-draft` 编辑做成「只改库、下次 sync 再投影」。
- 不把关张后的旧库目录当成再开张的默认工作台或候选源。
- 关张 / 出门不拆已投影链接（那是卸库的事）。
- 不设第三态 `bundled`；第一次确认不对 hash、不把现场升成 `catalog-managed`。
- 第一次同名内容不一致时不自动挑一份、不合并、不跳过该名继续装其余。
- 未开张时不让 `install` / `import` / `sync` / `upgrade` / `follow-catalog` / `agents add` 真空成功。
- 不开第二套开张入口（`init` / `bootstrap` 等）；只有 `open`。
- 不把 `claude-cursor` 当成在用单位或 `--agent` 别名；历史整目录 symlink 不是控制面模型。
- 不把 Claude Code 与 Cursor 耦合成「勾一个同时管两边」。
- 不把 marker 写成「只有 `sync` 才重写」。

## 现状与地基

本机仍有多套交叠 writer：dev-rules `sync.sh`（Cursor / Claude 整链 / Codex / Antigravity）、cc-switch 逐 skill 链接、Twin 安装器。

扩展现有地基，不重写：中央库、`content_hash`、backup、`sync_to_app_dir`、foreign / collision 守卫、`scan_unmanaged` / `import_from_apps`、`migrate_storage`。

现网 `enabled_*` 矩阵和「各 Agent 各开各的」UI **废止**，改为：库成员 + 在用 Agent 名单。

缺口：catalog reader（只往货架读，不自动进库）、Cursor / Antigravity adapter、在用名单、ownership marker、headless CLI（含 `open`）。历史 `~/.claude/skills → ~/.cursor/skills` 整目录 symlink 只在投影 Claude 时拆掉，不再作为写入模型。

## 核心模型

```text
Git Skill Sources
        ↓ exact repo + commit + path
agent-skills catalog（货架）
        ↓ 人确认后才进库
CC Switch library（工作台，~/.cc-switch/skills/<name>/）
        ↓ 在用 Agent 名单
per-agent adapters（symlink / copy）
```

### Catalog（货架）

沿用 [`agent-skills/schemas/skills.schema.json`](https://github.com/youxuanxue/agent-skills/blob/main/schemas/skills.schema.json)：

- `source.kind: self` → 当前 catalog commit 内路径。
- `source.kind: git` → `https://github.com/.../*.git` + 40 位 SHA。
- `recommended` **只**给「已勾在用 Agent 目录都空」的第一次技能候选；不是工作台状态，确认后不重放。

description 从来源 `SKILL.md` 派生；catalog 不维护第二份 metadata。

### 库（工作台）

每条库内 Skill 在 DB 标 provenance，只有两种：`catalog-managed`（从货架 `install` 进来，副本只读，跟总闸换版）/ `local-draft`（第一次现场、本机创建、导入，可编辑，不跟货架）。进库后的投影规则相同。

同名：货架新条目不得静默覆盖 `local-draft`；hash 完全一致才允许提升为 `catalog-managed`，否则 fail closed。第一次确认不对 hash、不提升。`catalog-managed` 磁盘 drift：`sync` fail closed，提示 Git owner，不静默覆盖。

装进库或从库卸下（货架 `install` / 本机创建 / 导入 / `uninstall`）：可勾一批、一次确认。对**全部在用 Agent** 预检（foreign collision、路径重叠、budget）通过后再改链接；任一名字或任一在用 Agent 写不上，整批失败、库成员不变。不把半截成功留下。中断后重跑必须收敛。

改 `local-draft` 存盘：先备份库内副本，再写库、再投影。任一在用 Agent 写不上则恢复备份（含 symlink 已看见新内容的 Agent），库内那份也不留下半截改。桌面存盘与经 core 的写入同一条。

### 在用 Agent

身份映射（禁止再发明第二套枚举）。`--agent` / 名单取值即下表 token。

| token | 现有 `AppType` | 角色 |
| --- | --- | --- |
| `claude` | `Claude` | Claude Code（不是 Desktop）；`get_app_skills_dir(Claude)` 下逐条 `~/.claude/skills/<name> → 库` |
| `cursor` | 新身份 Cursor | `~/.cursor/skills/<name> → 库` |
| `codex` | `Codex` | 可在用 |
| `gemini` | `Gemini` | 可在用；`~/.gemini/skills`（不是 Antigravity） |
| `grokbuild` | `GrokBuild` | 可在用 |
| `opencode` | `OpenCode` | 可在用 |
| `hermes` | `Hermes` | 可在用 |
| `pi` | `Pi` | 可在用；在用后磁盘跟库 |
| `antigravity` | 新身份 | 可在用 |
| — | `ClaudeDesktop` / `OpenClaw` | v1 不用 |

除 `cursor` / `antigravity` 外，现网路径以 `SkillService::get_app_skills_dir` 为 SSOT（单元测试固定）。`antigravity` 为 `~/.gemini/antigravity-cli/skills/<name>`。`claude` 就是 Claude Code 的逐条投影根，不再绕开它。

**Claude 与 Cursor 各自投影。** 勾选的是 Agent，不是历史耦合布局。两边都在用时各自写到同一中央库，互不耦合；只勾其中一个则只写那一侧。旧 token `claude-cursor` fail closed，提示改用 `claude` / `cursor`。

```text
~/.cursor/skills/<name>  → 库/<name>     （仅 cursor 在用）
~/.claude/skills/<name>  → 库/<name>     （仅 claude 在用）
```

历史遗留：若 `~/.claude/skills` 已是指向 Cursor 的整目录 symlink，**在投影 Claude 时**拆掉该链接（只删链接，不删 Cursor 内容），建成真实目录再逐条投影。外来真实目录仍 fail closed。未勾 Claude 时不碰这条历史链接。

第一次技能候选**只扫已勾为在用的** Agent 各自投影根（及其中已有的中央库投影）。未勾的目录、货架、其它发现源不进候选。只生成名单，不自动进库。同名 hash 不同则标冲突，确认被拒，直到人处理。

### Ownership marker

`~/.cc-switch/skills-control.json` 由 SQLite **生成**，禁止手改。权威是「库成员 + 在用名单」。**每次成功改在用名单或库成员后重写**：`open`、`install`、`uninstall`、`import`、`upgrade`、`follow-catalog`、`agents add|remove`、`sync`（不含 `--check`）。失败笔不改 marker。关张清空 marker。只跑 `sync` 才挂牌等于开张后 legacy 不停写。

```json
{
  "schema": 1,
  "owner": "cc-switch",
  "catalog_ref": {
    "repo": "https://github.com/youxuanxue/agent-skills.git",
    "revision": "<40-char-sha>"
  },
  "in_use_agents": ["claude", "cursor", "codex"],
  "follow_catalog": true
}
```

legacy writer 读到 marker 且自身对应 token 在 `in_use_agents` 内时必须停写。只看 symlink 不能证明已停写。

## 命令契约

当前 crate 无 bin。v1 必须提供与桌面同一 Rust core 的 headless 入口；子命令、`--json`、exit code 以本节为契约，分发留给 Core PR。

**未开张拒写。** 在用名单为空时，只有 `open` 可以写库。`sync`（不含 `--check`）、`install`、`uninstall`、`import`、`upgrade`、`follow-catalog`、`agents add` 一律拒绝，exit 非 0。`doctor` 与 `sync --check` 只读，可以跑。零个在用 Agent 不得当成「全部写齐」。

```bash
cc-switch skills open --agent <token>... [--skill <name>...]
cc-switch skills sync [--check]
cc-switch skills install <name>... | uninstall <name>...
cc-switch skills import <path>...
cc-switch skills upgrade [<name>]
cc-switch skills follow-catalog on | off
cc-switch skills agents add <token> | remove <token>
cc-switch skills doctor [--json]
```

- `open`：第一次确认工作台的唯一入口（桌面同一 core）。至少一个 `--agent`；零个 Agent 拒绝。`--skill` 只许来自本节第一次候选规则；省略则开张后工作台为空。同名冲突整笔停。现场标 `local-draft`，空机器 `recommended` 标 `catalog-managed`。成功后立刻重写 marker。已开张再跑 `open` 拒绝。不另设 `init` / `bootstrap`。

- `sync`：校验货架；副本被改脏则停。`follow_catalog=on` 时，把已在库中的 `catalog-managed` 对齐到当前货架（一笔，失败全回滚）。`off` 时不换版，只把**当前库**投影到在用 Agent。不把货架未入库条目装进来。`--check` 只计算。
- `install` / `uninstall`：可一批多名。从货架进库或出库是**一笔**：勾一批、一次确认；任一名字或任一在用 Agent 失败，整批都不进/不卸。不把半截成功留在库里。进库标 `catalog-managed`。
- `import`：本机路径 / zip（及现有 `import_from_apps`）进库，标 `local-draft`。与 `install` 同一笔：进库即投影到全部在用 Agent；失败整批不动。不跟总闸换版。桌面「新建技能」同一条。
- 改 `local-draft`（桌面存盘 / 经 core 的写入）：一笔投影；失败则库内副本回滚到存盘前。不另设 `edit` 子命令当第二开关。
- `upgrade`：钉死模式下的显式换版；省略 `<name>` 则升级库内全部已过期的 `catalog-managed`。同样整笔。
- `follow-catalog`：总闸，默认 `on`。
- `agents add`：**只在已开张时**按当前库对齐后入伙；未开张则拒绝。补不上则失败。多出来的外来物不碰。`remove`：该 Agent 退出在用，控制面不再写它；不拆它目录里已有的库投影，也不 cascading 删外来物。去掉最后一个 = 关张（清空库成员账与 marker；不拆链接；旧库文件留盘但不进下一次候选）。
- `doctor --json`：只读。妨碍安全投影则 **exit 1**（未开张不因此失败）。`--json` 是 UI / CI / dev-rules 的机器契约，字段以本节为准，禁止另写一份。

```json
{
  "schema": 1,
  "open": false,
  "follow_catalog": true,
  "catalog_ref": {
    "repo": "https://github.com/youxuanxue/agent-skills.git",
    "revision": "<40-char-sha-or-empty>"
  },
  "in_use_agents": [],
  "library": [],
  "projections": [],
  "foreign": [],
  "broken": [],
  "duplicate": [],
  "legacy_writers_stopped": [],
  "reload": []
}
```

`open` = 在用名单非空。未开张时 `library` 必须是 `[]`。已开张时：`library[]` 为 `{name, provenance, behind_catalog}`（`provenance` 仅为 `catalog-managed` | `local-draft`）；`projections[]` 为 `{agent, aligned, skill_count, description_chars}`。`legacy_writers_stopped` 只列已证明停写的在用 token。

## Legacy writer 过渡

| Provider | v1 | 稳定后 |
| --- | --- | --- |
| dev-rules | marker 里出现对应 token 则 skip 家目录 skill 写入 | 删除 home / global skill writer |
| Twin | `twin` 走 catalog git 源；在用后不再自己装 runtime 链接 | 删除 runtime skill installer |

dev-rules **保留**项目 `.cursor/skills` 编辑入口；**删除**的是 home 层 skill symlink writer。

## 安全

- catalog 是货架的信任边界；不从 runtime 目录自动提升进 catalog 或库。
- external source 只接受 schema 允许的 HTTPS Git + 完整 SHA。
- 只删除可证明为 cc-switch-owned 的投影；foreign / real dir 不碰。
- 路径逃逸、断链、循环、bundle 大小：沿用 `skill.rs` 并补 catalog 路径。

## 跨仓库 PR 顺序

1. **agent-skills** README writer 声明先合（[youxuanxue/agent-skills#66](https://github.com/youxuanxue/agent-skills/pull/66)）。货架门口不得还挂旧 writer。
2. **本文件 merge。** 进 main 前 `approved_by` 必须是具体人名（R5），禁止先合再翻。
3. **cc-switch Core**：catalog reader → 库成员 / 在用名单 → 本节全部 CLI（含 `open` / import / follow-catalog / upgrade，及未开张拒写）→ `claude` / `cursor` / Antigravity 各自逐条投影 → UI（库 + 在用 Agent + 诊断，无矩阵开关）。已落地：[#6](https://github.com/youxuanxue/cc-switch/pull/6) / `12e13692`，[#9](https://github.com/youxuanxue/cc-switch/pull/9) / `ff0d8a5d`。
4. **dev-rules / Twin**：inactive contract（小 PR，绑定本文件）。下一笔。
5. **在用 Agent 逐个入伙** → **删除 legacy writer**。

不把货架、Core、legacy contract、fan-out 塞进一个 PR。

## v1 成功标准（给下一个作者）

- 下一份实现不出现第二 writer、第二本启用账、技能 × Agent 开关。
- 库成员是工作集唯一 SSOT；symlink 与 `skills-control.json` 是生成物。
- 装/卸/导入/自建/入伙：可一批一笔；进库不看来源，全部在用 Agent 写齐才算成功，半截不留。provenance 只有两种：货架 `install` = `catalog-managed`，其余 = `local-draft`。无 `bundled`。
- 改 `local-draft` 存盘即再投影；写不齐则库内那份回滚，不留半截改。
- 第一次先勾在用 Agent（默认全不勾，看见过不预勾），再 `open` 确认工作台；一个都不勾 = 未开张；去掉最后一个在用 = 关张（账清空，不拆链接，旧库目录不当候选；目录里还在的算现场）；有现场不混 `recommended`；同名内容不一致则整笔停，不替人挑。未开张时除 `open` 外写库命令拒绝；`agents add` 只在已开张时入伙。
- `claude` 与 `cursor` 是两个在用单位。各自扫自己的投影根、各自逐条写到中央库。历史整目录 symlink 只在投影 Claude 时拆掉。`claude-cursor` 不是合法 token。
- 改在用名单或库成员的成功笔立刻重写 marker；关张清空。不靠事后 `sync` 才挂牌。
- catalog 新增默认不进库。
- 货架换版只有总闸「自动同步」（默认开）；关掉则钉死，显式 upgrade。不按技能设闸。自动跟上失败整笔回滚。
- foreign 不自动进库、不被删。
- 在用 token 上 legacy writer 可被 doctor 证明已停写。
- UI 与 CLI 同一 core、同一 `doctor --json` 字段。

## 验证（Core 实现 PR 承担）

- **单元**：catalog 解析、库成员、在用名单、`claude`/`cursor` 各自逐条投影且 Claude 根不是整目录 symlink、只开一侧不写另一侧、历史 Claude→Cursor 整目录 symlink 在开 Claude 时被拆掉、旧 token `claude-cursor` 拒绝、Pi 在用后跟库、整笔失败、foreign、先勾 Agent 再出候选、默认不预勾、零勾选不算开张、只有 `open` 能开张、`open` 成功即写 marker、未开张时 install/import/sync/upgrade/follow-catalog/agents add 拒绝、已开张再 `open` 拒绝、去掉最后一个为关张且清空 marker、关张不拆链接、关张后旧库目录不当候选且不挡住 `recommended`、空目录才用 `recommended`、catalog 新增不进库、follow_catalog 默认开、关掉则 sync 不换版、自动跟上失败整笔回滚、`local-draft` 进库即投影且不跟总闸、导入失败整批不动、改 `local-draft` 失败则库内回滚、第一次现场标 `local-draft` 且不对 hash 提升、空机器 `recommended` 标 `catalog-managed`、无 `bundled`、第一次同名 hash 不同则确认失败且库不动、`doctor --json` 含 `open`/`library`/`legacy_writers_stopped`。
- **集成**：先定在用再 `open` 且 marker 已挂；有现场只确认已用项且进库为 `local-draft`；同时勾 `claude`+`cursor` 且同名同 hash 各投影一份；同名冲突整笔停；关张后 `agents add` 拒绝、只能再 `open`；入伙对齐；一批装/卸/导入中断后收敛且半截不留；在用 Agent 失败则库不变、marker 不变；改 `local-draft` 投影失败后库与 Agent 都回到存盘前；关张后再开张不把旧库名单当候选，目录里还在的链接仍按现场提。
- **主机**：`doctor --json` 对当前在用名单 exit 0，字段与本节契约一致；屏幕上的库与 doctor 一致。

---

**Supersedes：** 本地 ignored 稿 `2026-08-27-skill-ssot-design.md`。以本文件为唯一审批基线。
