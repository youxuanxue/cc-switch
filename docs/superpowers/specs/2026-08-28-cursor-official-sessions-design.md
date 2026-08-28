# Cursor Official 与 Cursor Agent CLI 会话接入设计

**日期：** 2026-08-28  
**状态：** 已在对话中确认方案 A，等待书面设计复核  
**范围：** Cursor Official 认证管理、Cursor Agent CLI 会话索引、项目分类、对话预览与恢复

## 1. 目标

在不把 Cursor 伪装成第三方模型供应商的前提下，让 CC Switch 正式管理 Cursor Agent CLI 的官方认证状态，并把 Cursor 会话纳入现有会话管理器。

完成后用户可以：

1. 在「设置 → 认证」看到 Cursor Official 的正式支持状态、CLI 安装状态和当前认证状态。
2. 在 Cursor 登录和 Cursor User API Key 两种官方认证方式之间切换。
3. 在会话管理器中搜索 Cursor 会话，并沿用现有「工具 → 项目目录 → 会话」分类视图。
4. 预览存在本地 transcript 的 Cursor 对话。
5. 通过官方命令 `agent --resume <chat-id>` 恢复会话。

## 2. 非目标

本期明确不做：

- TokenKey、其他 OpenAI-compatible Base URL 或第三方推理服务接入。
- Cursor Desktop BYOK 管理。
- `agent-local`、`agent-cli-local` 或任何受限 entitlement 绕过。
- Cursor Proxy、Failover、MCP、Prompt、Skills 或通用 Provider 切换。
- Cursor 会话删除。
- 新会话的 `wts`/worktree 启动。本期只接入已有会话索引与恢复；隔离新会话单独设计。
- 修改 Cursor bundle、认证文件格式或私有控制面。

## 3. 产品边界

### 3.1 Cursor 不是通用 Provider App

Cursor Official 放在现有「设置 → 认证」页，而不是加入顶部 Provider App Switcher。

原因：

- Cursor 登录和 User API Key 是同一官方服务的两种认证方式，不是可切换的模型供应商。
- 将 Cursor 加入 `AppType` 会让 Provider、Proxy、MCP、Prompt 等模块被迫声明并不存在的能力。
- 专用认证面可以正式支持真实能力，同时避免 UI 暗示 TokenKey 或自定义 Base URL 已受支持。

### 3.2 三态能力模型

新增可复用的能力支持等级：

| 值 | 产品含义 | UI 文案 |
| --- | --- | --- |
| `supported` | 已有受支持实现和验证路径 | 正式支持 |
| `experimental` | 可用但兼容性或稳定性尚未形成正式承诺 | 实验性 |
| `conditional` | 只有检测到特定合法运行时或环境能力时才可用 | 条件支持 |

本期能力注册表只包含：

```text
cursor-official = supported
```

不得为 TokenKey、Cursor Desktop BYOK 或 `agent-local` 创建可见条目。能力等级是产品承诺的 SSOT，认证组件只消费它，不自行推导支持状态。

## 4. Cursor Official 认证

### 4.1 认证模式

认证配置只有两个值：

```text
login
userApiKey
```

- `login`：使用 Cursor CLI 自己维护的登录状态。CC Switch 不读写 Cursor token 文件，只调用公开的 `agent login` 和 `agent status --format json`。
- `userApiKey`：使用用户在 Cursor Dashboard 创建的 User API Key，通过 `CURSOR_API_KEY` 注入官方 Agent CLI。

两种模式可以同时具备凭据，但只有选中的模式会在 CC Switch 发起的状态检查和会话恢复中生效。

### 4.2 持久化

使用 CC Switch 现有 SQLite settings 存储，不新增数据库 schema：

```text
cursor.official.authMode
cursor.official.userApiKey
```

约束：

- 查询状态的 DTO 只能返回 `hasUserApiKey`，不得返回密钥正文。
- 保存接口把非空新值视为替换；切换模式不清除已保存密钥。
- 清除密钥必须走独立、显式命令。
- 日志、错误、toast、命令预览和测试 fixture 不得包含真实密钥。
- 密钥存储安全边界与 CC Switch 现有 Provider API Key 一致；本期不引入新的系统 Keychain 依赖。
- 导入导出、WebDAV/S3 备份与恢复继续沿用现有 Provider API Key 的数据库语义，不另造一套凭据同步规则。

### 4.3 状态探测

后端统一解析：

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
- Cursor 返回的账号显示信息；不返回 access token、refresh token 或密钥。
- 可展示的、已脱敏和截断的错误。

### 4.4 官方模式环境隔离

CC Switch 发起 Cursor Official 状态检查或恢复时，必须清理会把请求引向其他后端的环境变量：

```text
CURSOR_API_ENDPOINT
CURSOR_LOCAL_AGENT_BASE_URL
CURSOR_LOCAL_AGENT_API_KEY
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
```

User API Key 模式随后只注入 `CURSOR_API_KEY`。Login 模式还要移除 `CURSOR_API_KEY`。这保证「Cursor Official」不会因为用户 shell 的遗留环境静默变成第三方或本地推理模式。

## 5. 认证 UI

在 `AuthCenterPanel` 增加独立的 `CursorOfficialAuthSection`：

- 将面板总标题从仅指向 OAuth 的文案收敛为「官方认证中心」，覆盖既有 OAuth 账号和 Cursor Official，不改变原有账号功能。
- 标题：Cursor Official。
- 支持等级徽章：正式支持。
- CLI 状态：未安装、已安装版本、探测失败。
- 模式选择：Cursor 登录 / User API Key。
- Login 模式：展示登录状态和账号信息；提供“登录 Cursor”按钮，在首选终端运行 `agent login`。
- User API Key 模式：遮罩输入、新密钥保存、显式清除；展示当前密钥是否通过状态检查。
- 未安装、未认证或 Key 缺失时给出具体下一步，不显示虚假的可用状态。

认证组件只通过专用 API 工作，不访问 Provider CRUD，也不把 Cursor 加入 `AppId`。

## 6. 会话索引

### 6.1 数据来源

Cursor provider 以 `~/.cursor/chats` 的 metadata 为会话索引 SSOT：

```text
~/.cursor/chats/<workspace-bucket>/<chat-id>/meta.json
```

metadata 读取字段：

- `title`
- `cwd`
- `createdAtMs`
- `updatedAtMs`
- `hasConversation`

只索引 `hasConversation == true` 且 chat ID 合法的记录。损坏、缺字段或无法读取的单个文件被跳过，不阻断其他会话。

### 6.2 Transcript 匹配

对话预览来自：

```text
~/.cursor/projects/<project>/agent-transcripts/<chat-id>/<chat-id>.jsonl
```

启动一次扫描时先建立 `chat-id -> transcript path` 索引，再处理 metadata，避免对每个会话重复遍历 projects。

如果同一 chat ID 有多个 transcript：

1. 优先选择文件修改时间最新者。
2. 修改时间相同时按规范化路径字典序选择，保证结果确定。

没有 transcript 的 metadata 仍然进入会话列表并可恢复，只是不显示对话预览。

### 6.3 SessionMeta 映射

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

标题继续沿用现有 80 字符截断规则。`cwd` 直接进入现有项目目录分组，不创建第二套“项目”数据库。

### 6.4 对话解析

Cursor transcript 每行容错解析：

- `role == user` 映射为用户消息。
- `role == assistant` 映射为助手消息。
- `message.content` 数组中的 `text` 条目拼接为正文。
- 带 `name` 的工具条目映射为 `[Tool: <name>]`。
- 空内容、未知事件和损坏行跳过。

解析失败只影响当前行；读取文件失败返回现有会话详情错误路径。

## 7. 恢复与密钥边界

### 7.1 专用后端命令

Cursor 不复用 renderer 传入任意命令字符串的 `launch_session_terminal`。新增专用命令：

```text
launch_cursor_session(sessionId)
```

后端负责：

1. 校验 chat ID。
2. 从后端会话索引重新解析该 session 的 `cwd`，不信任 renderer 传入路径。
3. 读取当前 Cursor Official 认证模式。
4. 构造固定的 `agent --resume <chat-id>`。
5. 清理非官方 endpoint 环境。
6. 按模式注入或移除 `CURSOR_API_KEY`。
7. 使用用户现有首选终端启动。

前端展示的恢复命令永远不含密钥。

### 7.2 终端环境传递

macOS 终端启动需要一个权限为 `0700` 的临时 launcher 脚本：

- 脚本只包含固定 Agent 命令、经过 shell escaping 的 chat ID，以及当前认证模式所需环境。
- 脚本启动后先删除自身，再 `exec agent --resume ...`。
- 终端启动失败时后端立即删除脚本。
- 后端在创建新脚本前清理同目录下过期的 CC Switch Cursor launcher。
- 临时脚本路径可以出现在终端命令中，密钥正文不能出现。

非 macOS 沿用现有会话管理器的复制命令行为；User API Key 不拼入复制内容，UI 明确提示用户的 shell 需已设置 `CURSOR_API_KEY`。本期不扩大跨平台终端启动器范围。

## 8. 删除能力

现有 UI 把 `sourcePath` 同时当成“可预览”和“可删除”的信号，Cursor 接入后该假设不再成立。

在 `SessionMeta` 增加 `canDelete`：

- 现有八个 provider 显式为 `true`。
- Cursor 为 `false`。
- 单项删除、批量选择、分组选择和删除按钮全部只消费 `canDelete && sourcePath` 这一处判断。
- 后端 `delete_session` 对 `cursor` 继续返回 unsupported，形成第二道保护。

## 9. 代码边界

计划新增：

- `src-tauri/src/services/cursor_official.rs`：设置、状态探测和专用启动服务。
- `src-tauri/src/commands/cursor.rs`：窄 Tauri command 层。
- `src-tauri/src/session_manager/providers/cursor.rs`：会话扫描和 transcript 解析。
- `src/lib/api/cursor.ts`：前端 Cursor Official API。
- `src/config/cursorCapabilities.ts`：能力等级与 Cursor capability 注册表 SSOT。
- `src/components/settings/CursorOfficialAuthSection.tsx`：认证 UI。

计划修改：

- session manager 聚合、provider dispatch、Tauri command 注册。
- `SessionMeta` Rust/TypeScript 类型。
- 会话过滤、图标、标签、删除资格函数和四种语言文案。
- `AuthCenterPanel`。

不修改：

- `AppType`、`APP_IDS`、ProviderManager、Proxy、MCP、Prompt 和 Skills 数据模型。

## 10. 错误处理

- `agent` 不存在：返回 `installed=false`，认证按钮给出安装提示。
- `agent status` 非零退出：保留安装/版本信息，认证状态为失败，错误必须脱敏并限制长度。
- status JSON schema 变化：不得 panic；状态降级为 unknown，并展示兼容性错误。
- User API Key 模式未配置 Key：保存模式可以成功，但恢复按钮禁用并说明缺失项。
- metadata/transcript 某个文件损坏：跳过该文件或该行，其他会话继续显示。
- 项目目录不存在：会话仍可展示；恢复时沿用终端模块现有 cwd 失败反馈。

## 11. 测试与验收

### 11.1 Rust 单元测试

- 解析正常 metadata 并映射标题、cwd 和时间。
- 排除 `hasConversation=false`。
- 损坏 metadata 不影响其他记录。
- transcript 索引按 mtime、路径稳定去重。
- transcript 文本、工具调用、未知事件和损坏行解析。
- Cursor `canDelete=false`，删除 dispatch 拒绝 Cursor。
- Login/User API Key 两种模式生成正确的环境策略。
- 密钥不进入 argv、DTO、日志文本或恢复命令。
- launcher 脚本权限、自删除和启动失败清理。

### 11.2 前端测试

- 能力注册表只把 Cursor Official 标为 `supported`。
- Auth Center 展示 CLI、登录和 API Key 各状态。
- 密钥保存后只展示遮罩状态。
- 会话筛选包含 Cursor。
- 项目分类使用 `cwd`。
- Cursor 有 transcript 时可预览、无 transcript 时仍可恢复。
- Cursor 单项和批量删除均不可用。
- Cursor 恢复调用专用 API，其他 provider 保持现有通路。

### 11.3 真实 UI 验证

使用 Playwright 驱动实际 renderer：

1. 打开设置 → 认证，确认 Cursor Official 卡片、正式支持徽章和两种模式。
2. 以 mock Tauri IPC 验证未安装、登录成功、Key 缺失和 Key 已配置状态。
3. 打开会话管理，切换 Cursor 筛选和分类视图，确认 provider/project/session 层级。
4. 选择 Cursor 会话，确认恢复可用、删除不可用，并验证恢复调用的 IPC 参数不含密钥。

本地 smoke 还要在不输出账号和会话正文的前提下运行真实 `agent --version`、`agent status --format json` schema 探针，以及真实本地 Cursor 目录扫描计数。不得自动恢复私人会话或创建新会话，以免产生计费和历史副作用。

## 12. 完成标准

- Cursor Official 在认证中心标记为正式支持，并能管理 Login/User API Key 模式。
- TokenKey、Desktop BYOK 和 `agent-local` 未被误标为可用。
- Cursor 会话可搜索、按 `cwd` 分类、预览并通过官方命令恢复。
- Cursor 会话不能被删除。
- User API Key 不出现在 renderer、命令预览、argv、日志和测试产物中。
- Rust、前端单元测试、类型检查、格式检查和 Playwright 真实 UI 验证通过。
- 不改变现有九个 App 的 Provider、Proxy、MCP、Prompt、Skills 或会话行为。
