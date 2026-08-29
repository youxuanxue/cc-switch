---
title: Cursor Official 与 Cursor Agent CLI 会话接入设计
risk_level: high
status: approved
approved_by: user-chat-2026-08-28
---

# Cursor Official 与 Cursor Agent CLI 会话接入设计

**日期：** 2026-08-28
**状态：** 已批准，进入实施计划
**范围：** Cursor Official 认证、Cursor Agent CLI 会话索引、按 `cwd` 目录分组与恢复

## 1. 产品目标

用户真正要完成的任务不是“配置 Cursor”，而是：

> 找到过去的 Cursor 会话，然后继续工作。

认证只是恢复失败时的内联补救，不应成为用户进入会话管理前必须完成的配置流程。

完成后的主路径是：

1. 用户打开会话管理器并选择 Cursor。
2. CC Switch 按 Cursor metadata 中的 `cwd` 对会话做目录分组。
3. 用户通过标题、目录和最后活动时间找到会话并点击“继续会话”。
4. Cursor 已就绪时，直接通过 `agent --workspace <workspace> --resume <chat-id>` 恢复。
5. 原目录已经移动或删除时，原地显示“选择目录并继续”。
6. Cursor 尚未登录时，原地显示“登录并继续”；登录成功后在同一个终端继续目标会话。
7. User API Key 收进次级“其他方式”，用户需要时才展开。

「设置 → 认证」继续提供完整的 Cursor Official 配置和诊断入口，但它不是恢复会话的前置向导。

## 2. 非目标

本期明确不做：

- 新增 Project 领域模型、数据库表、Project ID、项目 CRUD 或项目生命周期。
- TokenKey、其他 OpenAI-compatible Base URL 或第三方推理服务接入。
- Cursor Desktop BYOK 管理。
- `agent-local`、`agent-cli-local` 或任何受限 entitlement 绕过。
- Cursor Proxy、Failover、MCP、Prompt、Skills 或通用 Provider 切换。
- Cursor 会话删除。`sourcePath` 只授权只读预览，不能当成删除授权。
- 新会话的 `wts`/worktree 启动。本期只接入已有会话索引与恢复；隔离新会话单独设计。
- 修改 Cursor bundle、认证文件格式或私有控制面。
- 自动恢复真实私人会话或创建新会话作为测试步骤。

## 3. 产品与领域边界

### 3.1 只有“项目目录分组”，没有 Project 实体

CC Switch 现有会话模型只有 `SessionMeta.projectDir`，前端已经通过 `groupSessionsByProviderAndDirectory` 按目录分组。Cursor metadata 的 `cwd` 直接映射到这个字段，并复用现有分组函数。

本期不会引入：

- `projects` 表或新的持久化 schema。
- `projectId`、项目名称编辑、项目创建/删除。
- 会话与项目实体之间的外键或迁移。
- worktree 与项目生命周期管理。

因此界面和文档的准确表述是“按项目目录分组”或“按目录分组”，不是“项目管理”。同一个 `cwd` 字符串下可以有多个会话；空 `cwd` 继续进入现有“未知目录”分组。

真正的 Project 实体只在未来同时承载 `wts` 新会话、worktree 生命周期和跨工具项目管理时再设计。

### 3.2 Cursor 不是通用 Provider App

Cursor Official 放在现有「设置 → 认证」页和会话管理器里，不加入顶部 Provider App Switcher。

原因：

- Cursor 登录和 User API Key 是同一官方服务的两种认证方式，不是可切换的模型供应商。
- 将 Cursor 加入 `AppType` 会迫使 Provider、Proxy、MCP、Prompt、Skills 等模块声明并不存在的能力。
- 独立认证和会话 adapter 可以正式支持真实能力，同时避免 UI 暗示 TokenKey 或自定义 Base URL 已受支持。

### 3.3 支持承诺按能力拆分

静态能力注册表使用三种状态：

```text
supported
conditional
unsupported
```

本期 Cursor 终端恢复的正式交付平台与 CC Switch 现有会话恢复一致，为 macOS。下表的 `supported` 表示在这个产品平台边界内正式支持；Windows/Linux 由运行态单独显示不可用，不把平台缺口伪装成认证失败。

Cursor 本期能力如下：

| 能力 | 支持状态 | 含义 |
| --- | --- | --- |
| Cursor 官方登录 | `supported` | 使用公开的 `agent login` 与 `agent status --format json` |
| Cursor User API Key | `supported` | 使用官方 `CURSOR_API_KEY` |
| `agent --workspace … --resume <chat-id>` | `supported` | 使用公开的官方 workspace 与恢复参数 |
| 本地会话索引 | `conditional` | 依赖本机存在且可解析的 `~/.cursor/chats` |
| Transcript 预览 | `supported` | 只读解析 `store.db`，复用现有对话记录与目录 |
| Cursor 会话删除 | `unsupported` | 本期不修改 Cursor 私有历史存储 |

能力状态只作为代码和测试中的产品承诺 SSOT，不渲染到用户界面。用户只看到当前机器上的两层运行态和下一步动作：

```text
数据源：索引就绪 / 索引不可用
恢复：已就绪 / 需要选择目录 / 需要登录 / 需要 API Key / CLI 未安装 / 平台不可用
```

会话详情头栏展示可复制的固定恢复命令，与其他供应商同一套 chrome。“正式支持 / 条件支持 / 不支持”不出现在 UI。CLI 版本、探测错误和文件来源仍只出现在认证中心的技术详情里。

## 4. 信息架构与恢复体验

### 4.1 会话管理器是主入口

Cursor 出现在会话工具筛选和现有“工具 → 项目目录 → 会话”层级中。这里的“项目目录”完全由 `cwd` 派生，不产生项目实体。

选中 Cursor 会话后，主要动作只有：

- “继续会话”。

列表和详情主视觉与其他会话同一套头栏：标题、时间、项目目录、源文件、可复制的固定恢复命令，以及“恢复会话”。选中后中间复用“对话记录”和右侧目录。未就绪时才在头栏下方插入登录/选目录等补救，不另做一块 Cursor 专用详情卡。Cursor 不支持删除时，删除按钮、批量勾选框和分组删除入口全部隐藏，不展示禁用按钮。`sourcePath` 只用于只读预览，不能重新当成删除授权。

### 4.2 两层状态，而不是一个大状态机

Cursor 数据源状态由会话列表 owner 负责，只决定能否列出本地会话：

| 数据源状态 | 用户看到的结果 |
| --- | --- |
| 索引就绪 | 展示 Cursor 会话 |
| 索引不可用 | 在 Cursor 筛选下展示诊断空状态，不影响其他 provider |

“索引就绪但没有会话”使用普通空状态；只有索引根目录不可读或布局无法识别时才是“索引不可用”。

当前会话恢复状态由一个独立的共享 owner 负责，只决定主按钮动作：

| 恢复状态 | 用户看到的动作 | 系统行为 |
| --- | --- | --- |
| 已就绪 | 继续会话 | 在确定的 workspace 中启动 `agent --workspace <workspace> --resume <chat-id>` |
| 需要选择目录 | 选择目录并继续 | 打开原生目录选择器，校验目录后继续当前恢复流程 |
| 需要登录 | 登录并继续 | 同一终端先运行 `agent login`，成功后继续目标会话 |
| 需要 API Key | 配置并继续 | 原地展开共享的 Key 控件，保存、校验后恢复 |
| CLI 未安装 | 安装 Cursor CLI | 显示安装说明，隐藏不可执行的恢复动作 |
| 平台不可用 | 不可用 | 说明当前只在 macOS 支持恢复，不提供不安全的命令拼接降级 |

“其他方式”是切换到 User API Key 的次级动作，不是一个恢复状态。状态派生优先级固定为：平台 → CLI → workspace → 认证 → 已就绪。

workspace 与认证同时未就绪时，先解决 workspace。用户选中目录后，`CursorResumeGate` 在当前选中会话内暂存 override 并重新派生状态：认证已就绪则立即恢复；仍需登录或 API Key 则保留该 override，完成认证后继续同一会话。切换会话或离开页面时清除临时 override；本期不修改 Cursor metadata、不改变目录分组，也不新增持久化映射。

如果 Key 无效或登录失败，用户仍停留在当前会话上下文中，可以重试或切换认证方式，不被迫跳转到设置页重新寻找会话。认证探测错误作为当前认证补救状态的错误详情展示，不新增额外的恢复状态。

### 4.3 认证控件只有一个 owner

认证中心和会话页的内联补救共享同一个 Cursor Official 认证控件、状态 hook 和后端 service：

- 认证中心负责完整管理和诊断。
- 会话页只以紧凑形态展示恢复所需的动作。
- 保存、清除、状态刷新、错误脱敏和模式切换走同一条代码路径。

这满足多端 UI 行为 SSOT：页面只负责布局与 props 接线，不复制认证状态机。

## 5. 认证中心

在 `AuthCenterPanel` 增加独立的 Cursor Official 区域，并调整中心级文案：

- 总标题从“OAuth 认证中心”改为“官方认证中心”。
- 删除中心级 `Beta` 徽章，避免它覆盖并降级 Cursor 的正式支持承诺。
- 既有 Copilot、Codex OAuth 和 xAI 区域行为不变；若它们需要 Beta 标识，应由各自能力自行声明。
- Cursor 区域主状态显示“已就绪 / 需要登录 / 需要 API Key / CLI 未安装 / 状态不可用”；它只表达 CLI 与认证，不混入会话索引或 workspace 状态。
- Login 是默认且首要方式；User API Key 位于“其他方式”。
- CLI 版本、最近探测错误和文件来源收进“技术详情”；静态支持等级不渲染。

认证区只通过 Cursor 专用 API 工作，不访问 Provider CRUD，也不把 Cursor 加入 `AppId`。

## 6. Cursor Official 认证

### 6.1 认证模式

认证配置只有两个值：

```text
login
userApiKey
```

- `login`：使用 Cursor CLI 自己维护的登录状态。CC Switch 不读写 Cursor token 文件，只调用公开的 `agent login` 和 `agent status --format json`。
- `userApiKey`：使用用户在 Cursor Dashboard 创建的 User API Key，通过 `CURSOR_API_KEY` 注入官方 Agent CLI。

两种方式可以同时具备凭据，但只有选中的模式会在 CC Switch 发起的状态检查和会话恢复中生效。首次使用默认选择 `login`。

### 6.2 本机持久化与备份边界

Cursor Official 设置写入现有本机 `AppSettings` 文件，不写入 SQLite，也不新增数据库 schema：

```text
cursorOfficial.authMode
cursorOfficial.userApiKey
```

选择这个位置的原因是：`settings.json` 是现有设备级设置边界，并且不属于当前 WebDAV/S3 的“数据库 + Skills”同步产物。把 Cursor 密钥放入该文件前，`save_settings_file` 必须改用现有 `config::atomic_write_private`：Unix 上无论新建还是替换都以 `0600` 落盘，并避免截断写造成半文件。不能只依赖 `OpenOptions::mode(0o600)`，因为它不会收紧已存在文件的旧权限。

约束：

- 通用 `get_settings` 返回前必须移除整个 `cursorOfficial` 私密配置；通用 `save_settings` 无条件保留后端现有值，不能接受 renderer 对该字段的修改。
- Cursor 专用状态 DTO 的凭据字段只能是 `authMode` 与 `hasUserApiKey`，不得返回已保存密钥正文；它仍可携带 CLI 版本、是否认证、非敏感账号显示信息和脱敏错误。
- 密钥只在用户输入并提交时短暂存在于 renderer；保存后后端不得再次回传。
- 专用保存接口把非空新值视为替换；切换模式不清除已保存密钥。
- 清除密钥必须走独立、显式的 Cursor 命令。
- 日志、错误、toast、命令预览、argv 和测试 fixture 不得包含真实密钥。
- Cursor User API Key 不进入 WebDAV/S3、SQL 导出、数据库备份或数据库恢复。
- 操作系统或用户自行进行的整机/目录备份仍可能包含本机 `settings.json`；UI 的技术详情中要准确说明这个边界。
- 未来若支持凭据跨设备同步，必须另做显式 opt-in、加密和冲突处理设计，不能沿用普通设置同步并静默上传。

认证配置只通过窄命令读写：

```text
get_cursor_official_status()
update_cursor_official_auth(authMode, userApiKey?)
clear_cursor_user_api_key()
```

`update_cursor_official_auth` 只接受 `login | userApiKey`；省略 Key 表示保留既有值，非空 Key 表示替换，空字符串必须拒绝并提示使用显式清除命令。三个命令都只返回脱敏状态。这样切换模式、复用已保存 Key、替换 Key 和清除 Key 的语义互不混淆。

### 6.3 状态探测

后端统一探测：

```bash
agent --version
agent status --format json
```

User API Key 模式通过子进程环境变量传入 `CURSOR_API_KEY`，不放入 argv。Login 模式显式移除 `CURSOR_API_KEY`，避免 CC Switch 进程继承的环境变量覆盖用户选择。

返回给前端的状态包括：

- CLI 是否安装及版本。
- 当前认证模式。
- 是否已配置 User API Key。
- 当前模式是否认证成功。
- Cursor 返回的非敏感账号显示信息。
- 已脱敏、截断且适合展示的错误。
- 由统一函数派生的运行态，而不是由各页面自行判断。

### 6.4 官方模式环境隔离

CC Switch 发起 Cursor Official 状态检查、登录或恢复时，必须清理会把请求引向其他后端的环境变量：

```text
CURSOR_API_ENDPOINT
CURSOR_LOCAL_AGENT_BASE_URL
CURSOR_LOCAL_AGENT_API_KEY
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
```

User API Key 模式随后只注入 `CURSOR_API_KEY`。Login 模式还要移除 `CURSOR_API_KEY`。这保证“Cursor Official”不会因为用户 shell 的遗留环境静默变成第三方或本地推理模式。

## 7. 会话索引与目录分组

### 7.1 Metadata 索引

Cursor adapter 以 `~/.cursor/chats` 的 metadata 为本地会话索引来源：

```text
~/.cursor/chats/<workspace-bucket>/<chat-id>/meta.json
```

读取字段：

- `title`
- `cwd`
- `createdAtMs`
- `updatedAtMs`
- `hasConversation`

损坏、chat ID 非法或无法读取的单个文件被跳过，不阻断其他会话。`cwd` 为空或目录已经不存在时仍然保留会话，由恢复状态机提供“选择目录并继续”，不能因为工作区移动而让历史会话消失。

索引根目录 `~/.cursor/chats` 不存在、不可读或整体布局无法识别时，Cursor 数据源状态为“索引不可用”，不影响其他 provider。索引状态探测与 metadata 扫描复用同一个根目录/布局解析函数，不能各自维护判断规则。

### 7.2 Metadata 确定性去重

一个 chat ID 在 UI 中只能出现一个会话。扫描所有可解析 metadata 后，先按 chat ID 分组，再按以下顺序选择唯一记录：

1. `updatedAtMs` 较新的记录优先；缺失时间按 `0` 处理。
2. `updatedAtMs` 相同时，选择规范化 metadata 路径字典序最小的记录。
3. 选出唯一记录后，仅当它的 `hasConversation == true` 时进入会话列表。

这条规则同时用于首次扫描和恢复前的后端重新解析，避免列表展示与实际恢复选择不同的 metadata。

### 7.3 `SessionMeta` 映射

```text
providerId    = cursor
sessionId     = chat-id
title         = meta.title
projectDir    = meta.cwd
createdAt     = meta.createdAtMs
lastActiveAt  = meta.updatedAtMs
sourcePath    = 同目录 store.db（文件存在时）
resumeCommand = 空
```

`projectDir` 只用于现有目录分组和恢复 workspace，不代表 Project 实体。`resumeCommand` 留空以阻止 Cursor 落入现有 renderer 任意命令恢复路径；Cursor 专用恢复面板根据后端上下文展示固定命令形状并调用专用 API。标题继续沿用现有截断规则。

### 7.4 Transcript 只读预览

对话预览只读取会话目录下的 `store.db`。扫描只在该文件存在时写入 `sourcePath`；加载时文件名必须是 `store.db`，否则拒绝。解析只走根 blob 上的直接引用，跳过 `system`，不把 `sourcePath` 当成删除授权。不扫描 `~/.cursor/projects/*/agent-transcripts`。目录导航可隐藏 `<user_info>` 信封，正文仍走共享对话记录。

## 8. 恢复与密钥边界

### 8.1 专用后端接口

Cursor 不复用 renderer 传入任意命令字符串的 `launch_session_terminal`。现有 `list_sessions` 返回结构保持不变；Cursor 通过窄接口补充数据源诊断、当前会话 workspace 上下文和恢复动作：

```text
get_cursor_session_index_status()
get_cursor_session_resume_context(sessionId, workspaceOverride?)
launch_cursor_session(sessionId, workspaceOverride?)
launch_cursor_login()
launch_cursor_login_and_session(sessionId, workspaceOverride?)
```

接口结果使用结构化状态，不让前端解析错误字符串：

```text
get_cursor_session_index_status
  -> { state: indexReady }
   | { state: indexUnavailable, reason }

get_cursor_session_resume_context
  -> { workspaceState: ready }
   | { workspaceState: required }

launch_cursor_session / launch_cursor_login_and_session
  -> { state: launched }
   | { state: workspaceRequired }
```

`reason` 必须脱敏并限制长度。索引状态接口只调用 Cursor scanner 共用的根目录/布局 resolver，不维护第二套探测规则；恢复上下文与最终启动都调用同一个“按 chat ID 去重并重新解析 metadata”的函数。恢复上下文接收 override 时也执行与启动相同的路径校验，最终启动仍再次校验以覆盖 TOCTOU。这样现有 provider 的 `list_sessions -> Vec<SessionMeta>` 契约和行为不变。

后端负责：

1. 校验 chat ID。
2. 按 metadata 去重规则重新解析该 session，保证列表与恢复使用同一记录。
3. 优先使用仍然存在的 metadata `cwd`；原目录失效且没有 override 时返回结构化的 `workspaceRequired`，不启动失败终端。
4. 对 `workspaceOverride` 做存在性、目录类型和 canonicalize 校验；文件、失效路径和无法规范化的路径全部拒绝。
5. 读取当前 Cursor Official 认证模式和本机密钥。
6. 构造固定的 `agent --workspace <canonical-workspace> --resume <chat-id>`，或 `agent login` 成功后继续该命令。
7. 清理非官方 endpoint 环境。
8. 按模式注入或移除 `CURSOR_API_KEY`。
9. 使用用户现有首选终端启动。

收到 `workspaceRequired` 后，前端复用现有 `pick_directory` Tauri 命令打开原生目录选择器。用户取消选择则保持当前会话和页面状态；用户选择目录后，先用带 override 的恢复上下文接口校验，再暂存该路径并按“workspace → 认证 → 已就绪”的剩余状态继续。

前端展示的恢复命令永远不含密钥。Renderer 不能传入任意 Cursor 命令或环境变量；workspace override 是唯一允许传入的路径参数。正常 UI 只从原生目录选择流程产生该值，但后端不信任其来源，必须独立校验后才作为固定 `--workspace` 参数使用。

### 8.2 临时 launcher

现有会话终端恢复只支持 macOS；Cursor 在同一平台边界内使用权限为 `0700` 的临时 launcher：

- 终端只接收 launcher 路径，不接收密钥正文。
- launcher 包含固定 Agent 命令、经过 shell escaping 的 chat ID 和已校验 workspace，以及当前认证模式所需环境。
- launcher 启动后先删除自身，再执行命令。
- “登录并继续”执行 `agent login`；只有退出成功才 `exec agent --workspace <workspace> --resume <chat-id>`。
- 启动终端失败时后端立即删除 launcher。
- 创建新 launcher 前清理同目录下超过限定存活时间的 CC Switch Cursor launcher。
- launcher 路径可以出现在日志和终端命令中，密钥正文不能出现。

Windows/Linux 不新增一套未经验证的密钥拼接或剪贴板降级。本期 UI 按现有终端恢复平台能力显示“不可用”，会话索引仍可独立工作。

## 9. 删除行为

Cursor 现在会为 `store.db` 填充 `sourcePath`，但删除能力仍是 `unsupported`。不能把 `sourcePath` 当成删除授权，也不能只靠字段为空来隐藏删除入口。

- 前端使用一个共享的 `isSessionDeletable(session)` 资格函数；现有 provider 继续按 `sourcePath` 判断，Cursor 固定返回 `false`，即使已有 transcript 路径。
- 单项删除按钮和会话勾选框只在资格为 `true` 时渲染；provider/目录分组没有可删除会话时不渲染分组勾选框。
- 当前筛选没有任何可删除会话时不提供批量管理入口；若用户从其他筛选切到该状态，自动退出批量模式并清空选择。
- Cursor 不进入后端删除 dispatch，直接返回 unsupported，形成独立于 UI 的第二道保护。
- Cursor 不计入可批量删除数量。

本期不改变现有 provider 的 `SessionMeta` 或删除行为。

## 10. 技术边界与代码 owner

计划新增：

- `src-tauri/src/services/cursor_official.rs`：本机设置、状态探测、环境策略和专用启动服务。
- `src-tauri/src/commands/cursor.rs`：窄 Tauri command 层。
- `src-tauri/src/session_manager/providers/cursor.rs`：metadata 扫描、确定性去重与 `SessionMeta` 映射。
- `src/lib/api/cursor.ts`：前端 Cursor Official API。
- `src/config/cursorCapabilities.ts`：逐能力支持等级注册表。
- `src/hooks/useCursorOfficial.ts`：认证查询、保存、清除与刷新行为的唯一 owner。
- `src/hooks/useCursorSessionIndex.ts`：Cursor 数据源状态查询的唯一 owner。
- `src/components/cursor/CursorOfficialAuthControl.tsx`：认证中心与恢复补救共用的认证控件。
- `src/components/settings/CursorOfficialAuthSection.tsx`：认证中心编排。
- `src/components/sessions/cursorResumeState.ts`：按固定优先级派生恢复状态的纯函数。
- `src/components/sessions/CursorResumeGate.tsx`：会话恢复动作编排，消费共享认证和恢复状态 owner。
- `src/components/sessions/sessionCapabilities.ts`：会话删除资格的唯一前端 owner，保持现有 provider 行为并排除 Cursor。
- `scripts/check-cursor-session-ssot.mjs`：机械校验认证、恢复状态和删除资格 owner 的消费关系，并禁止 Cursor 调用通用 `launch_session_terminal`。
- `.preflight/local-lint.conf`：把上述契约检查登记进项目 preflight；该检查验证 import/调用关系，不以“文件存在”冒充行为测试。

计划修改：

- `AppSettings` 的本机 Cursor Official 设置和前端脱敏合并逻辑。
- `save_settings_file` 改用私密原子写入，并在 Unix 上把既有设置文件收紧为 `0600`。
- session manager 聚合、provider dispatch、Tauri command 注册。
- 会话过滤、图标、标签、技术详情、Cursor 详情主体与删除控件渲染。
- `AuthCenterPanel` 的标题、中心级 Beta 与 Cursor 区域。
- 四种语言文案。

不修改：

- `AppType`、`APP_IDS`、ProviderManager、Proxy、MCP、Prompt 和 Skills 数据模型。
- SQLite schema、Project 相关领域模型和现有 provider 的 `SessionMeta`/删除行为。

上述共享 owner 同时由行为测试覆盖。机械契约检查只防止未来合并删除 owner、复制状态派生或绕回通用恢复 IPC，不能替代 Rust、前端和真实 UI 测试。

## 11. 错误处理

- `agent` 不存在：返回 `installed=false`，显示安装说明，不渲染可执行恢复按钮。
- `agent status` 非零退出：保留安装/版本信息，认证状态为失败，错误必须脱敏并限制长度。
- status JSON schema 变化：不得 panic；认证中心显示“状态不可用”，会话恢复在当前认证补救状态下展示兼容性摘要和重试入口。
- Login 未认证：会话原地提供“登录并继续”。
- User API Key 模式未配置 Key：原地提供“配置并继续”，不把用户丢到另一个页面。
- Key 无效：保留当前会话选择，展示可重试错误并允许切回 Login。
- 单个 metadata 损坏：跳过该文件，其他会话继续显示。
- 同一 chat ID 有多份 metadata：按统一去重规则只展示和恢复一个会话。
- `~/.cursor/chats` 整体不可读：只把 Cursor 索引标记为不可用，不阻断其他会话 provider。
- 原项目目录不存在：会话仍可展示；恢复返回 `workspaceRequired`，原地提供“选择目录并继续”。
- 用户取消目录选择：不启动终端、不显示失败 toast，保持当前会话。
- workspace override 不存在、不是目录或无法 canonicalize：拒绝启动并返回可操作错误。
- workspace 与认证同时未就绪：先选择目录，保留当前会话的临时 override，再完成登录或 API Key 补救；最终只启动一次恢复命令。
- 恢复上下文探测后目录被移动：最终启动重新校验并返回 `workspaceRequired`，前端回到目录选择动作。
- 临时 launcher 创建或终端启动失败：清理临时文件并返回不含密钥的错误。

## 12. 测试与验收

### 12.1 Rust 单元测试

- 解析正常 metadata 并映射标题、`cwd` 和时间。
- 排除 `hasConversation=false`。
- 损坏 metadata 不影响其他记录。
- metadata 重复时按 `updatedAtMs`、规范化路径稳定去重，列表与恢复选择一致。
- 索引状态与扫描复用同一个根目录/布局 resolver；索引不可用不改变 `list_sessions` 的既有返回契约。
- `cwd` 为空或目录不存在的会话仍进入索引。
- Cursor `sourcePath` 仅在 `store.db` 存在时指向该文件；`resumeCommand` 仍为空，不能进入通用终端恢复路径。删除仍拒绝 Cursor。
- 原目录失效且没有 override 时返回 `workspaceRequired`，不启动终端。
- workspace override 只接受可 canonicalize 的现有目录，拒绝文件和失效路径。
- 恢复命令固定为 `agent --workspace <workspace> --resume <chat-id>`。
- 删除 dispatch 拒绝 Cursor。
- Login/User API Key 两种模式生成正确的环境策略。
- Login 模式清除继承的 `CURSOR_API_KEY`；官方模式清除第三方 endpoint 环境。
- 密钥不进入 argv、DTO、日志文本或恢复命令。
- 通用 `get_settings` 不包含 `cursorOfficial`；通用保存不能覆盖或清空既有 Cursor 配置。
- 专用 Cursor 状态的凭据字段只返回 `authMode` 与 `hasUserApiKey`，专用保存/清除命令按预期更新密钥。
- 认证更新命令会拒绝未知模式和空字符串 Key；省略 Key 保留既有值，显式清除不会被通用保存回放。
- 私密原子写入不会留下半文件；Unix 上新建和既有 `settings.json` 保存后权限均为 `0600`。
- WebDAV/S3 和数据库导出不包含 Cursor User API Key。
- launcher 权限、自删除、登录后恢复、启动失败清理和过期清理。

### 12.2 前端测试

- 能力注册表逐项返回 `supported`、`conditional`、`unsupported`。
- 能力支持等级不渲染到 UI。
- Auth Center 不再显示中心级 Beta，并展示 Cursor 当前运行态。
- Login 是主方式，User API Key 位于“其他方式”。
- 认证中心和会话恢复复用同一认证状态 owner。
- 密钥保存后只展示 `hasUserApiKey` 遮罩状态。
- 会话筛选包含 Cursor。
- 目录分类直接使用 `cwd`，不创建或读取 Project 实体。
- 数据源状态与当前会话恢复状态由不同 owner 派生。
- Cursor 在存在 `store.db` 时请求会话消息，并复用共享对话记录、消息数和目录导航；删除入口仍然全部隐藏。
- 删除资格函数保持现有 provider 行为并固定拒绝 Cursor；Cursor 单项删除、选择框、分组删除和批量删除入口全部隐藏，而不是禁用。
- 项目 preflight 的 Cursor SSOT 契约检查能发现页面绕过共享认证/恢复/删除 owner，或 Cursor 重新调用通用终端恢复 IPC。
- 已就绪时恢复调用专用 API；未登录时显示并调用“登录并继续”。
- 原目录失效时显示“选择目录并继续”；取消选择保持当前状态，选择目录后保留 override，按认证状态立即恢复或继续内联补救。
- 平台、CLI、workspace、认证同时变化时严格按固定优先级派生；切换会话会清除旧会话的 override。
- CLI 未安装、平台不可用和索引不可用时展示各自明确的下一步。
- 就绪 Cursor 会话使用与其他会话相同的头栏命令预览；登录/选目录补救只在未就绪时出现。

### 12.3 真实 UI e2e

使用 Playwright 驱动实际 renderer；后端状态通过 Tauri IPC 测试边界注入，不以直调 handler 代替 UI：

1. 打开设置 → 认证，确认“官方认证中心”、Cursor 运行态、Login 主路径和“其他方式”。
2. 验证未安装、登录成功、需要登录、Key 缺失和 Key 已配置状态。
3. 打开会话管理，切换 Cursor 筛选和目录分组，确认“工具 → 目录 → 会话”层级以及重复 chat ID 只显示一次。
4. 选择已就绪会话，确认一次点击调用 `launch_cursor_session(chat-id)`，且不调用通用 `launch_session_terminal`。
5. 选择原目录失效的会话，确认原地出现“选择目录并继续”；取消选择无 toast，选择新路径后以该 override 继续。
6. 构造“目录失效 + 未登录”和“目录失效 + API Key 缺失”组合，确认只选择一次目录，认证完成后使用保留的 override 恢复。
7. 选择未登录且目录有效的会话，确认原地出现“登录并继续”并调用 `launch_cursor_login_and_session(chat-id)`。
8. 确认有 `store.db` 的 Cursor 会话能翻对话记录，头栏有固定恢复命令，删除入口和能力支持等级仍不存在。
9. 确认 IPC 参数不含密钥、任意命令或环境变量；即使直接伪造 workspace override，后端也会拒绝文件、失效路径和无法 canonicalize 的路径。

### 12.4 本机 smoke

在不输出账号、API Key 和会话正文的前提下：

- 运行真实 `agent --version`。
- 运行真实 `agent status --format json` schema 探针，只报告字段存在性和成功状态。
- 扫描真实本地 Cursor 目录，只报告 metadata、唯一 chat ID、重复记录和失效 `cwd` 的数量。
- 不自动运行 `agent login`、不恢复私人会话、不创建新会话。

## 13. 完成标准

- 用户能在现有会话管理器找到 Cursor 会话，并按 `cwd` 目录分组；系统没有新增 Project 实体。
- 同一个 chat ID 只显示一个确定性选择的会话，列表与恢复使用同一 metadata。
- Cursor 已就绪时，一次点击通过官方 `agent --workspace <workspace> --resume <chat-id>` 恢复。
- 原目录失效时，用户能原地选择新目录并继续，不会打开一个只执行失败 `cd` 的终端。
- Cursor 未登录时，用户不离开当前会话即可“登录并继续”。
- Login 与 User API Key 均为正式支持；TokenKey、Desktop BYOK 和 `agent-local` 未被误标为可用。
- 本地索引不可用会准确降级，不阻断其他 provider。
- 有 `store.db` 的 Cursor 会话能翻对话记录；没有该文件时显示共享空状态。删除仍不可用。
- Cursor 会话不能被删除，且界面不展示无效删除入口。
- User API Key 保存后不从后端返回，不进入 argv、日志、命令预览、WebDAV/S3 或数据库备份。
- 认证中心没有误导性的全局 Beta；主视觉只表达运行态，能力支持等级不出现在 UI。
- Rust、前端单元测试、类型检查、格式检查和 Playwright 真实 UI e2e 通过。
- 不改变现有 App 的 Provider、Proxy、MCP、Prompt、Skills 或会话行为。
