---
title: Cursor Official 与 Cursor Agent CLI 会话接入设计
risk_level: high
status: pending
approved_by: pending
---

# Cursor Official 与 Cursor Agent CLI 会话接入设计

**日期：** 2026-08-28
**状态：** 已按乔布斯复审修订，等待书面设计最终复核
**范围：** Cursor Official 认证、Cursor Agent CLI 会话索引、按 `cwd` 目录分组、对话预览与恢复

## 1. 产品目标

用户真正要完成的任务不是“配置 Cursor”，而是：

> 找到过去的 Cursor 会话，然后继续工作。

认证只是恢复失败时的内联补救，不应成为用户进入会话管理前必须完成的配置流程。

完成后的主路径是：

1. 用户打开会话管理器并选择 Cursor。
2. CC Switch 按 Cursor metadata 中的 `cwd` 对会话做目录分组。
3. 用户选择会话、查看可用的对话预览并点击“继续会话”。
4. Cursor 已就绪时，直接通过 `agent --resume <chat-id>` 恢复。
5. Cursor 尚未登录时，原地显示“登录并继续”；登录成功后在同一个终端继续目标会话。
6. User API Key 收进次级“其他方式”，用户需要时才展开。

「设置 → 认证」继续提供完整的 Cursor Official 配置和诊断入口，但它不是恢复会话的前置向导。

## 2. 非目标

本期明确不做：

- 新增 Project 领域模型、数据库表、Project ID、项目 CRUD 或项目生命周期。
- TokenKey、其他 OpenAI-compatible Base URL 或第三方推理服务接入。
- Cursor Desktop BYOK 管理。
- `agent-local`、`agent-cli-local` 或任何受限 entitlement 绕过。
- Cursor Proxy、Failover、MCP、Prompt、Skills 或通用 Provider 切换。
- Cursor 会话删除。
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
| `agent --resume <chat-id>` | `supported` | 使用公开的官方恢复命令 |
| 本地会话索引 | `conditional` | 依赖本机存在且可解析的 `~/.cursor/chats` |
| Transcript 预览 | `conditional` | 依赖本机存在且可解析的 `agent-transcripts` |
| Cursor 会话删除 | `unsupported` | 本期不修改 Cursor 私有历史存储 |

能力状态是代码中的产品承诺 SSOT，但不是主视觉。用户首先看到运行态：

```text
已就绪 / 需要登录 / 需要 API Key / CLI 未安装 / 会话索引不可用 / 不可用
```

“正式支持 / 条件支持 / 不支持”和 CLI 版本、文件路径、命令等只出现在可折叠的技术详情中。

## 4. 信息架构与恢复体验

### 4.1 会话管理器是主入口

Cursor 出现在会话工具筛选和现有“工具 → 项目目录 → 会话”层级中。这里的“项目目录”完全由 `cwd` 派生，不产生项目实体。

选中 Cursor 会话后，主要动作只有：

- “继续会话”。
- 有 transcript 时查看对话预览。

路径、source path、chat ID、恢复命令和能力支持状态默认收进“技术详情”。Cursor 不支持删除时，删除按钮、批量勾选框和分组删除入口全部隐藏，不展示禁用按钮。

### 4.2 点击“继续会话”的状态机

恢复入口由一个共享状态机负责，页面不各自复制认证判断：

| 运行态 | 用户看到的动作 | 系统行为 |
| --- | --- | --- |
| 已就绪 | 继续会话 | 直接启动 `agent --resume <chat-id>` |
| Login 模式但未登录 | 登录并继续 | 同一终端先运行 `agent login`，成功后继续目标会话 |
| User API Key 模式但未配置 | 配置并继续 | 原地展开共享的 Key 控件，保存、校验后恢复 |
| Login 模式下用户选择其他方式 | 其他方式 | 展开 User API Key，不抢占主按钮 |
| CLI 未安装 | 安装 Cursor CLI | 显示安装说明，隐藏不可执行的恢复动作 |
| 会话索引不可用 | 查看诊断 | 保留错误摘要，完整路径和解析信息放进技术详情 |

如果 Key 无效或登录失败，用户仍停留在当前会话上下文中，可以重试或切换认证方式，不被迫跳转到设置页重新寻找会话。

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
- Cursor 区域主状态显示“已就绪 / 需要登录 / CLI 未安装 / 不可用”。
- Login 是默认且首要方式；User API Key 位于“其他方式”。
- CLI 版本、静态支持等级、最近探测错误和文件来源收进“技术详情”。

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

选择这个位置的原因是：现有 `settings.json` 已以 Unix `0600` 权限保存 WebDAV/S3 等本机凭据，并且不属于当前 WebDAV/S3 的“数据库 + Skills”同步产物。

约束：

- 查询 DTO 只能返回 `hasUserApiKey`，不得返回已保存密钥正文。
- 密钥只在用户输入并提交时短暂存在于 renderer；保存后后端不得再次回传。
- 保存接口把非空新值视为替换；切换模式不清除已保存密钥。
- 清除密钥必须走独立、显式命令。
- 通用 `save_settings` 路径必须保留被前端遮罩掉的既有密钥，不能用空值覆盖。
- 日志、错误、toast、命令预览、argv 和测试 fixture 不得包含真实密钥。
- Cursor User API Key 不进入 WebDAV/S3、SQL 导出、数据库备份或数据库恢复。
- 操作系统或用户自行进行的整机/目录备份仍可能包含本机 `settings.json`；UI 的技术详情中要准确说明这个边界。
- 未来若支持凭据跨设备同步，必须另做显式 opt-in、加密和冲突处理设计，不能沿用普通设置同步并静默上传。

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

只索引 `hasConversation == true` 且 chat ID 合法的记录。损坏、缺字段或无法读取的单个文件被跳过，不阻断其他会话。目录不存在或布局无法识别时，Cursor 的本地会话索引运行态为“不可用”，不影响其他 provider。

### 7.2 Transcript 匹配

对话预览来自：

```text
~/.cursor/projects/<project>/agent-transcripts/<chat-id>/<chat-id>.jsonl
```

一次扫描先建立 `chat-id -> transcript path` 索引，再处理 metadata，避免每个会话重复遍历 projects。

如果同一 chat ID 有多个 transcript：

1. 优先选择文件修改时间最新者。
2. 修改时间相同时按规范化路径字典序选择，保证结果确定。

没有 transcript 的 metadata 仍进入会话列表并可恢复，只隐藏对话预览。

### 7.3 `SessionMeta` 映射

```text
providerId    = cursor
sessionId     = chat-id
title         = meta.title
projectDir    = meta.cwd
createdAt     = meta.createdAtMs
lastActiveAt  = meta.updatedAtMs
sourcePath    = matched transcript path 或空
resumeCommand = agent --resume <chat-id>
canDelete     = false
```

`projectDir` 只用于现有目录分组和恢复 cwd，不代表 Project 实体。标题继续沿用现有 80 字符截断规则。

### 7.4 对话解析

Cursor transcript 每行容错解析：

- `role == user` 映射为用户消息。
- `role == assistant` 映射为助手消息。
- `message.content` 数组中的 `text` 条目拼接为正文。
- 带 `name` 的工具条目映射为 `[Tool: <name>]`。
- 空内容、未知事件和损坏行跳过。

解析失败只影响当前行；读取文件失败复用现有会话详情错误路径。

## 8. 恢复与密钥边界

### 8.1 专用后端命令

Cursor 不复用 renderer 传入任意命令字符串的 `launch_session_terminal`。Cursor 专用命令只接收受限意图和 `sessionId`：

```text
launch_cursor_session(sessionId)
launch_cursor_login()
launch_cursor_login_and_session(sessionId)
```

后端负责：

1. 校验 chat ID。
2. 从后端 Cursor metadata 索引重新解析该 session 的 `cwd`，不信任 renderer 传入路径或 source path。
3. 读取当前 Cursor Official 认证模式和本机密钥。
4. 构造固定的 `agent --resume <chat-id>`，或 `agent login` 成功后继续该命令。
5. 清理非官方 endpoint 环境。
6. 按模式注入或移除 `CURSOR_API_KEY`。
7. 使用用户现有首选终端启动。

前端展示的恢复命令永远不含密钥；renderer 也不能传入任意 Cursor 命令、cwd 或环境变量。

### 8.2 临时 launcher

现有会话终端恢复只支持 macOS；Cursor 在同一平台边界内使用权限为 `0700` 的临时 launcher：

- 终端只接收 launcher 路径，不接收密钥正文。
- launcher 包含固定 Agent 命令、经过 shell escaping 的 chat ID 和 cwd，以及当前认证模式所需环境。
- launcher 启动后先删除自身，再执行命令。
- “登录并继续”执行 `agent login`；只有退出成功才 `exec agent --resume <chat-id>`。
- 启动终端失败时后端立即删除 launcher。
- 创建新 launcher 前清理同目录下超过限定存活时间的 CC Switch Cursor launcher。
- launcher 路径可以出现在日志和终端命令中，密钥正文不能出现。

Windows/Linux 不新增一套未经验证的密钥拼接或剪贴板降级。本期 UI 按现有终端恢复平台能力显示“不可用”，会话索引和预览仍可独立工作。

## 9. 删除能力解耦

现有 UI 把 `sourcePath` 同时当成“可预览”和“可删除”的信号，Cursor 接入后该假设不再成立。

在 Rust 与 TypeScript 的 `SessionMeta` 增加 `canDelete`：

- 现有 provider 显式为 `true`，保持当前行为。
- Cursor 为 `false`。
- 单项删除、批量选择、分组选择和删除入口统一消费 `canDelete && sourcePath`。
- Cursor 不可删除时隐藏相关入口，不显示禁用按钮。
- 后端 `delete_session` 对 `cursor` 继续返回 unsupported，形成第二道保护。

`sourcePath` 只表达“存在可读取的会话详情来源”，不再隐含删除权限。

## 10. 技术边界与代码 owner

计划新增：

- `src-tauri/src/services/cursor_official.rs`：本机设置、状态探测、环境策略和专用启动服务。
- `src-tauri/src/commands/cursor.rs`：窄 Tauri command 层。
- `src-tauri/src/session_manager/providers/cursor.rs`：metadata 扫描、transcript 索引与解析。
- `src/lib/api/cursor.ts`：前端 Cursor Official API。
- `src/config/cursorCapabilities.ts`：逐能力支持等级注册表。
- `src/components/cursor/CursorOfficialAuthControl.tsx`：认证中心与恢复补救共用的认证控件。
- `src/components/settings/CursorOfficialAuthSection.tsx`：认证中心编排。
- `src/components/sessions/CursorResumeGate.tsx`：会话恢复状态编排，消费共享认证 owner。

计划修改：

- `AppSettings` 的本机 Cursor Official 设置和前端脱敏合并逻辑。
- session manager 聚合、provider dispatch、Tauri command 注册。
- Rust/TypeScript `SessionMeta`。
- 会话过滤、图标、标签、技术详情和删除资格函数。
- `AuthCenterPanel` 的标题、中心级 Beta 与 Cursor 区域。
- 四种语言文案。

不修改：

- `AppType`、`APP_IDS`、ProviderManager、Proxy、MCP、Prompt 和 Skills 数据模型。
- SQLite schema 和 Project 相关领域模型。

## 11. 错误处理

- `agent` 不存在：返回 `installed=false`，显示安装说明，不渲染可执行恢复按钮。
- `agent status` 非零退出：保留安装/版本信息，认证状态为失败，错误必须脱敏并限制长度。
- status JSON schema 变化：不得 panic；状态降级为 unavailable，并展示兼容性摘要。
- Login 未认证：会话原地提供“登录并继续”。
- User API Key 模式未配置 Key：原地提供“配置并继续”，不把用户丢到另一个页面。
- Key 无效：保留当前会话选择，展示可重试错误并允许切回 Login。
- metadata/transcript 某个文件损坏：跳过该文件或该行，其他会话继续显示。
- `~/.cursor/chats` 整体不可读：只把 Cursor 索引标记为不可用，不阻断其他会话 provider。
- 项目目录不存在：会话仍可展示；恢复时使用现有终端 cwd 失败反馈，不猜测新目录。
- 临时 launcher 创建或终端启动失败：清理临时文件并返回不含密钥的错误。

## 12. 测试与验收

### 12.1 Rust 单元测试

- 解析正常 metadata 并映射标题、`cwd` 和时间。
- 排除 `hasConversation=false`。
- 损坏 metadata 不影响其他记录。
- transcript 索引按 mtime、路径稳定去重。
- transcript 文本、工具调用、未知事件和损坏行解析。
- Cursor `canDelete=false`，删除 dispatch 拒绝 Cursor。
- Login/User API Key 两种模式生成正确的环境策略。
- Login 模式清除继承的 `CURSOR_API_KEY`；官方模式清除第三方 endpoint 环境。
- 密钥不进入 argv、DTO、日志文本或恢复命令。
- `settings.json` 前端脱敏与通用保存不会清空既有密钥。
- WebDAV/S3 和数据库导出不包含 Cursor User API Key。
- launcher 权限、自删除、登录后恢复、启动失败清理和过期清理。

### 12.2 前端测试

- 能力注册表逐项返回 `supported`、`conditional`、`unsupported`。
- Auth Center 不再显示中心级 Beta，并展示 Cursor 运行态。
- Login 是主方式，User API Key 位于“其他方式”。
- 认证中心和会话恢复复用同一认证状态 owner。
- 密钥保存后只展示 `hasUserApiKey` 遮罩状态。
- 会话筛选包含 Cursor。
- 目录分类直接使用 `cwd`，不创建或读取 Project 实体。
- Cursor 有 transcript 时可预览，无 transcript 时仍可恢复。
- Cursor 单项删除、选择框、分组删除和批量删除入口全部隐藏。
- 已就绪时恢复调用专用 API；未登录时显示并调用“登录并继续”。
- CLI 未安装和索引不可用时展示明确下一步。
- source path、chat ID 和恢复命令默认只在技术详情中出现。

### 12.3 真实 UI e2e

使用 Playwright 驱动实际 renderer；后端状态通过 Tauri IPC 测试边界注入，不以直调 handler 代替 UI：

1. 打开设置 → 认证，确认“官方认证中心”、Cursor 运行态、Login 主路径和“其他方式”。
2. 验证未安装、登录成功、需要登录、Key 缺失和 Key 已配置状态。
3. 打开会话管理，切换 Cursor 筛选和目录分组，确认“工具 → 目录 → 会话”层级。
4. 选择已就绪会话，确认一次点击调用 `launch_cursor_session(chat-id)`。
5. 选择未登录会话，确认原地出现“登录并继续”并调用 `launch_cursor_login_and_session(chat-id)`。
6. 确认 Cursor 删除入口完全不存在，技术详情默认折叠，IPC 参数不含密钥、cwd 或任意命令。

### 12.4 本机 smoke

在不输出账号、API Key 和会话正文的前提下：

- 运行真实 `agent --version`。
- 运行真实 `agent status --format json` schema 探针，只报告字段存在性和成功状态。
- 扫描真实本地 Cursor 目录，只报告 metadata、唯一 chat ID、transcript 和匹配数量。
- 不自动运行 `agent login`、不恢复私人会话、不创建新会话。

## 13. 完成标准

- 用户能在现有会话管理器找到 Cursor 会话，并按 `cwd` 目录分组；系统没有新增 Project 实体。
- Cursor 已就绪时，一次点击通过官方 `agent --resume <chat-id>` 恢复。
- Cursor 未登录时，用户不离开当前会话即可“登录并继续”。
- Login 与 User API Key 均为正式支持；TokenKey、Desktop BYOK 和 `agent-local` 未被误标为可用。
- 本地索引和 transcript 缺失会准确降级，不阻断恢复或其他 provider。
- Cursor 会话不能被删除，且界面不展示无效删除入口。
- User API Key 保存后不从后端返回，不进入 argv、日志、命令预览、WebDAV/S3 或数据库备份。
- 认证中心没有误导性的全局 Beta；主视觉表达运行态，支持等级收进技术详情。
- Rust、前端单元测试、类型检查、格式检查和 Playwright 真实 UI e2e 通过。
- 不改变现有九个 App 的 Provider、Proxy、MCP、Prompt、Skills 或会话行为。
