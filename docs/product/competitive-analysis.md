---
title: CC Switch / Tandem 竞品分析
status: draft
updated_at: 2026-07-31
evidence: 本机一手证据（Claude Code 2.1.220、官方 marketplace 快照、cc-switch 源码）
network: 本次调研外网出口被 TLS 中间层拦截，未使用网络检索
---

# CC Switch / Tandem 竞品分析

## 证据与局限

本轮分析的结论全部来自本机可复核的一手证据：

- 本机安装的 Claude Code `2.1.220`（`claude --version`）的实际 CLI 契约与配置面。
- 本机 `~/.claude/plugins/marketplaces/claude-plugins-official` 官方市场快照（39 个 plugin，`lastUpdated: 2026-07-31`）。
- cc-switch 当前分支源码（`src/`、`src-tauri/`、`src/i18n/locales/`）。
- 本机其他工具的真实配置目录：`~/.codex`、`~/.gemini`、`~/.grok`、`~/.config/opencode`、`~/.agents`。

局限必须记录：本次会话的外网出口被 TLS 中间层拦截（`curl` 对 `docs.claude.com`、`github.com` 均返回 `tlsv1 alert protocol version`，WebSearch 返空）。因此本文不包含厂商路线图、融资、市场份额等只能靠检索获得的信息，也不宣称覆盖了全部同类产品。凡涉及“上游是否已实现”的判断，均以源码为准而非文档描述。

## 竞争格局：三条不同的赛道

cc-switch 常被笼统称为“Claude Code 配置切换器”，但从能力面看，它实际处在三条赛道的交叉处，而三条赛道的竞争者完全不同。

| 赛道 | 竞争者形态 | cc-switch 现状 | 威胁性质 |
| --- | --- | --- | --- |
| 凭据 / Provider 切换 | 中转服务商自带的桌面客户端、各类 `*-switch` 脚本 | 强势领先：8 个工具、50+ 预设、代理与故障转移、SQLite SSOT | 功能被商业中转方原生内置 |
| Agent 资产分发（skills / MCP / prompts / **agents**） | 工具厂商自己的官方分发体系 | 部分覆盖：skills / MCP / prompts 已管，**agents 未管** | 被官方体系直接吸收 |
| 任务与工作现场编排 | 官方后台 agent、云端 agent 平台 | 尚未进入（Tandem 的目标） | 官方先占位 |

第一条赛道 cc-switch 领先且护城河来自工具数量与写入安全（原子写入、双向回填、备份轮换）。真正的战略风险集中在第二与第三条。

## Claude Code 的 agents：最紧迫的竞品动向

### agents 已是官方一等公民

本机 Claude Code 2.1.220 的实测结果显示，agents 不再是社区约定，而是官方产品的三个独立层次：

**1. 后台 agent 编排（`claude agents`）**

`claude agents --help` 显示的能力是一个完整的调度面，而非一个开关：

```
--agent <agent>            默认 agent
--model <model>            默认模型
--effort <level>           默认 effort 等级
--permission-mode <mode>   默认权限模式
--mcp-config <config>      注入 MCP 配置（可重复）
--plugin-dir <path>        加载 plugin 目录（可重复）
--settings <file-or-json>  注入 settings
--setting-sources <...>    user / project / local
--add-dir <directory>      额外授权目录（可重复）
--cwd <path>               按路径筛选后台会话
--json                     以 JSON 输出活跃会话（供脚本消费）
```

这里每一个 flag 都落在 Tandem 设计文档声称要提供的能力上：模型路由、权限模式、MCP 注入、目录授权、按项目筛选会话、机器可读的会话状态。官方已经把“为一次任务准备执行上下文并派发”做成了 CLI 契约。

**2. agent 定义文件（`agents/*.md`）**

官方市场的 39 个 plugin 中，8 个带 plugin 级 `agents/` 目录，共 31 个 agent 定义。字段分布（分母为 34，即含下述 3 个 skill 内嵌 agent）：

| 字段 | 出现文件数 | 含义 |
| --- | --- | --- |
| `name` | 31 / 34 | 标识 |
| `description` | 31 / 34 | 调度依据（何时该用这个 agent） |
| `model` | 23 / 34 | 模型绑定（含 `inherit`） |
| `tools` | 22 / 34 | 工具白名单 |
| `color` | 19 / 34 | UI 呈现 |
| `effort` | 7 / 34 | 推理预算 |

存在两种不同机制，产品实现时必须区分：

- **注册型 agent**（31 个）：位于 plugin 直属 `agents/`，带 frontmatter，由 Claude Code 识别并纳入调度。
- **内嵌指令型 agent**（3 个）：位于 `skill-creator/skills/skill-creator/agents/`，**无 frontmatter**，不被自动注册，由 `SKILL.md` 正文显式引用后按需读取（原文：「The agents/ directory contains instructions for specialized subagents. Read them when you need to spawn the relevant subagent.」）。

只按目录名扫描 `agents/` 会把后者误当作可管理的 agent 定义。判据是 frontmatter 是否存在，而非路径。

实例（`hookify/agents/conversation-analyzer.md`）：

```yaml
---
name: conversation-analyzer
description: Use this agent when analyzing conversation transcripts...
model: inherit
color: yellow
tools: ["Read", "Grep"]
---
```

关键观察：agent 定义同时承载**模型绑定**与**工具权限**。这两件事恰好是 cc-switch 的核心业务——它管 provider / 模型路由，也管 MCP / skills 的启用。agent 文件把二者打包进了一个 markdown 文件，绕过了 cc-switch 的管理面。

**3. plugin + marketplace 分发体系（`claude plugin`）**

```
claude plugin install / enable / disable / list / details / prune
claude plugin marketplace add / list / remove / update
claude plugin init            # 脚手架
claude plugin eval            # 对 plugin 跑评测并打分
```

本机已注册官方市场 `anthropics/claude-plugins-official`（GitHub source）。一个 plugin 的组件构成（39 个 plugin 统计）：

```
25  .claude-plugin/   （manifest）
15  skills/
13  commands/
 8  agents/
 6  hooks/
 2  workflows/
 2  scripts/
```

这是本文最重要的一条结论：**skills 只是 plugin 的一个组件，而 plugin 才是官方的分发单位。** cc-switch 的 Skills 面板管理的是 plugin 的一个子集，官方的分发粒度已经上移了一层。`claude plugin details` 还会给出“组件清单与预计 token 成本”，`claude plugin eval` 能对 plugin 跑评测——官方在这一层提供的能力已经超出“安装与同步”。

### cc-switch 的 agents 缺口：入口已占位，实现为空

源码证据显示上游明确意识到了这个缺口，并已经占好了位置：

- `src/App.tsx:105,151` 定义了 `agents` view 并注册进 `VALID_VIEWS`。
- `src/App.tsx:1176` 用 `t("agents.title")` 渲染标题；i18n 中 zh 为「智能体」、en 为 `Agents`。
- `src/App.tsx:942` 渲染 `<AgentsPanel />`。

而 `src/components/agents/AgentsPanel.tsx` 全文 22 行，是一个占位符：

```tsx
<h3 className="text-xl font-semibold">Coming Soon</h3>
<p>The Agents management feature is currently under development.
   Stay tuned for powerful autonomous capabilities.</p>
```

后端侧同样为空。`src-tauri/src/services/` 有 `skill.rs`（4455 行）、`mcp.rs`、`prompt.rs`，但没有任何 agent 定义相关的服务。`grep` 到的 `agents` 字样全部指向另外两类东西：

- `prompt_files.rs:34,36` — `AGENTS.md`（Codex / Grok / OpenCode / OpenClaw / Hermes 的指令文件），属于 Prompts 能力。
- `openclaw_config.rs` — OpenClaw 的 `agents.defaults`，即**默认模型与回退模型配置**。i18n 自述为「管理 openclaw.json 中的 agents.defaults 配置（默认模型、运行参数等）」。

必须明确区分：`openclawAgents` 视图是**模型路由配置**，与 Claude Code 的 subagent 定义不是同一件事。上游目前没有任何地方管理 `agents/*.md` 这类 agent 定义。

结论：cc-switch 在导航上承诺了「智能体」，在实现上是空的。这是一个已公开的空缺，而不是尚未被发现的机会。

### skills 侧的既有资产可以复用

cc-switch 的 skills 实现给 agents 提供了现成的架构范式，这是它的真实优势：

`SkillService`（`src-tauri/src/services/skill.rs`）已经具备一套完整的跨工具资产分发机制：

- **SSOT + 分发**：`get_ssot_dir()` 支持 `~/.cc-switch/skills/` 或统一标准目录 `~/.agents/skills/`；`get_app_skills_dir()` 为 8 个工具各自解析目标路径，并支持用户 override。
- **双向同步**：`sync_to_app` / `copy_to_app` / `remove_from_app` / `import_from_apps`。
- **接管未管理资产**：`scan_unmanaged()` 扫描各工具目录下已存在但未纳管的 skill，并解析 `~/.agents/.skill-lock.json` 识别其 GitHub 来源。
- **版本与安全**：`compute_dir_hash` / `check_updates` / `update_skill` / 备份与 `restore_from_backup`。
- **多来源安装**：GitHub 仓库、ZIP、`skills.sh` 搜索、Deep Link。

其中 `~/.agents/skills/` 这个选择尤其重要：cc-switch 已经在向**跨工具中立标准**对齐，而不是绑死单一厂商目录。agent 定义文件（`agents/*.md`）在形态上与 skill 高度同构——都是带 frontmatter 的 markdown 目录资产、都有来源仓库、都需要按工具分发与启用。这套机制迁移到 agents 的边际成本不高。

### 跨工具可移植性：需求真实，但不能假设对称

本机检查了其他工具的配置面，结果是 agent 定义层高度不对称：

| 工具 | agent 定义目录 | 本机实测 |
| --- | --- | --- |
| Claude Code | `agents/*.md`（plugin 内 / 用户级） | 官方一等公民，官方市场 31 个注册型定义 |
| Codex | 无 | `~/.codex` 只有 `AGENTS.md` + `config.toml`，无 `agents/` |
| Gemini CLI | 无 | `~/.gemini` 无 `agents/` |
| Grok | 无 | `~/.grok` 无 `agents/` |
| OpenCode | 无 | `~/.config/opencode/opencode.jsonc` 仅 `$schema` |
| OpenClaw | 不同概念 | `agents.defaults` 是模型路由 |

这印证了设计文档 §7「对封闭工具承诺到哪里」已经写下的红线：统一外观不能制造能力一致的假象。agents 管理在第一阶段实质上是**Claude Code 单工具能力**，而不是像 skills 那样的八工具通用能力。把它放进一个暗示“所有工具都支持”的统一面板，会重复设计文档明确禁止的错误。

## 对 Tandem 的战略含义

### 官方后台 agent 与 Tandem 的定位重叠

`claude agents` 的能力集与 Tandem 设计文档中的核心承诺存在实质重叠：

| Tandem 设计承诺 | Claude Code 已有对应 |
| --- | --- |
| 为任务准备执行上下文再派发工具 | `claude agents --model/--effort/--permission-mode/--mcp-config` |
| 装载个人规则与 Skills | `--plugin-dir` / `--settings` / `--setting-sources` |
| 按项目查看可恢复任务 | `claude agents --cwd <path> --json` |
| 项目目录授权 | `--add-dir`（可重复） |

差异点是真实的，也正是 Tandem 应当据守的位置：

1. **跨工具**：`claude agents` 只调度 Claude Code。Tandem 的价值在于同一任务能在 Claude Code、Codex、Grok 之间接力。
2. **工作现场隔离**：官方没有 submodule-safe worktree 编排。设计文档中共享 `wtree.py` 引擎这条是官方不覆盖的能力。
3. **凭据与成本**：官方不管中转商、余额、故障转移、跨供应商成本归集，这些是 cc-switch 的既有资产。

反过来说，如果 Tandem 把“单工具内的 agent 派发”当作核心卖点，那是在与官方 CLI 正面竞争一个官方持续投入的能力。设计文档「原生工具保持原生」这条原则在这里得到了外部验证——不是审美偏好，而是竞争现实。

### 分发单位必须从 skill 上移到 plugin

设计文档 §原生能力继承表把 Skills 列为一项独立能力，owner 是「Skills SSOT」。官方证据要求修正这个模型：官方的分发单位是 plugin，skills 只是其一个组件（39 个 plugin 中 15 个含 skills，13 个含 commands，8 个含 agents，6 个含 hooks）。

若 cc-switch 继续只管 skills，会出现一个具体的用户可见故障：用户从官方市场安装一个 plugin，其中 skills 部分被 cc-switch 纳管，而 agents / commands / hooks 部分不可见也不可控。同一个资产被两套系统各管一半，正是 cc-switch 用 SSOT 架构极力避免的状态。

### “搭子”与官方 plugin 生态的关系需要定义

设计文档把「搭子」（Companion）定义为可携带、经用户确认的工作方式，并规划了 Companion Compiler。官方 plugin 体系已经是一个带市场、带版本、带评测（`claude plugin eval`）的可携带工作方式分发渠道。

两者关系必须显式定义，否则搭子会退化成第三套与官方市场重复的资产管理面。可行的差异化方向：搭子承载的是**跨工具的、经用户确认的个人偏好**（路由策略、项目装载、确认过的习惯），而 plugin 承载的是**单工具的、可公开分发的能力包**。前者是 Tandem 独有的，后者应当直接消费官方生态而非另建。

## 建议的产品动作

按优先级排列，均可由现有证据支撑：

1. **补齐 agents 管理，复用 skills 架构。** `AgentsPanel` 的 Coming Soon 是已对用户公开的承诺。实现路径是把 `SkillService` 的 SSOT + 分发 + `scan_unmanaged` + hash 版本管理范式迁移到 agent 定义（`agents/*.md`）。第一阶段只对 Claude Code 生效，界面必须明示这一点，不伪装为跨工具能力。

2. **把分发单位从 skill 提升到 plugin。** 至少做到：识别 plugin 边界、展示其组件构成（skills / agents / commands / hooks）、避免同一 plugin 被拆散管理。这是防止与官方生态产生管理割裂的必要动作。

3. **在设计文档中显式承认 `claude agents` 的存在，并据此收紧 Tandem 的差异化叙事。** 差异化守在跨工具接力、工作现场隔离、凭据与成本三点上；不把单工具 agent 派发当卖点。

4. **定义搭子与官方 plugin 市场的分工。** 搭子 = 跨工具个人偏好；plugin = 单工具可分发能力包。搭子消费官方生态，不复制它。

5. **区分两类 agents 概念，避免命名污染。** `openclawAgents`（模型路由）与新的 agents（定义管理）在导航上必须可区分，否则用户会认为「智能体」面板管的是模型默认值。

## 待确认判断

- agents 管理第一阶段是否接受“仅 Claude Code 生效”，并在 UI 明示工具范围。
- 是否把分发单位正式改为 plugin，Skills 面板降级为 plugin 的一个视图。
- 搭子与官方 plugin 市场的边界是否按“跨工具个人偏好 vs 单工具能力包”固化。
- 是否为 `claude agents --json` 建立适配器，把官方后台会话纳入“继续任务”的可恢复来源。
- 「智能体」这个 i18n 命名是否保留，以及如何与 OpenClaw 的 `agents.defaults` 在导航上区分。
