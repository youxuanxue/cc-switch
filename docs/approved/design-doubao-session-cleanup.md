---
title: Doubao Desktop 会话清理安全接入设计
risk_level: high
status: pending
approved_by: pending
---

# Doubao Desktop 会话清理安全接入设计

**日期：** 2026-09-04
**状态：** 待审批，禁止进入自动删除实现
**范围：** Doubao Desktop 账号会话在 CC Switch 清理入口中的安全接入

## 1. 目标与范围确认

用户希望在 CC Switch 清理历史会话时也能处理豆包中的大量历史会话。本设计把“豆包”定义为 bundle id 为 `com.bot.pc.doubao` 的 Doubao Desktop，而不是 `claude-doubao`：后者只是为 Claude Code 替换鉴权 token 的 launcher，会话仍由现有 Claude provider 管理，重复建立 provider 会造成同一会话被扫描和删除两次。

本期目标是让用户从同一个清理入口看见豆包，并安全进入豆包自己的历史管理流程。CC Switch 不在本期读取或删除豆包账号会话。

## 2. 本机调查结论

只读调查基于本机 Doubao Desktop `2.27.12`：

- 本地用户数据位于 `~/Library/Application Support/Doubao`，是完整 Chromium profile，不是会话专用目录。
- `Default/IndexedDB/chrome_doubao-chat_0.indexeddb.leveldb` 是共享 LevelDB；豆包运行时持有其 `LOCK`，且不存在“一条会话一个文件”的边界。
- `Default/.doubao/agent_mode/workspace` 主要保存 Agent 技能资源；`sandbox_envs_dir/envs` 保存可复用执行环境。两者都没有稳定证据表明与一条历史会话一一对应。
- 豆包前端通过账号侧接口列出和删除会话。随应用代码中可见 `cursor`、`batch_size`、`conversation_types` 的列表请求，以及 `conversation_ids`、`delete_all` 的批量删除请求。
- 实际删除还经过豆包内部 IM 指令 `/im/conversation/batch_del_user_conv`，并携带会话类型；该协议未公开、未版本化，也没有供第三方使用的认证契约。
- 豆包自己的历史管理界面支持普通、归档、项目、设备、本地等多类会话。当前可见的批量选择路径存在上限，并没有可供 CC Switch 复用的“未活跃且非运行中”公共语义。
- 删除是账号侧操作，本地 IndexedDB 更接近缓存。删除缓存既不能可靠删除云端历史，也可能破坏登录态、同步状态或其他豆包数据。

因此，直接把豆包 profile、IndexedDB、Agent workspace 或 sandbox 目录注册成现有文件型 `SessionProvider` 是错误的数据模型。

## 3. 风险判定

这是高风险变更，原因是目标动作会永久改变第三方账号侧数据，且当前只有未公开协议，没有可验证的恢复能力或兼容性承诺。错误实现可能批量删除正在使用、已归档、属于项目或跨设备同步的会话。

本设计遵循失败关闭：无法证明目标、权限、活跃状态和删除语义时，CC Switch 不显示可执行的自动删除动作。

## 4. 产品决策

### 4.1 本期：由原应用管理

在现有“清理会话”界面增加“由原应用管理”的数据源区域。检测到 Doubao Desktop 后显示：

- 名称：豆包
- 范围：账号会话
- 状态：由豆包管理
- 主动作：在豆包中管理

主动作只通过 macOS bundle id 激活或启动已安装的 Doubao Desktop。若未来确认了豆包公开且稳定的历史管理 deep link，可以在不扩大权限的前提下替换为该 deep link；当前不得猜测或拼接私有 URL。

豆包不进入当前清理确认按钮的 targets，不进入“将删除 N 个会话”的计数，也不复用 `SessionMeta.sourcePath` 伪造可删除会话。这样既让清理对象集合覆盖豆包，又不会让用户误以为 CC Switch 已经能够安全代删。

### 4.2 后续：一等自动清理的解锁条件

只有豆包提供公开、稳定且允许第三方调用的 API、CLI 或 SDK，并同时满足以下条件，才能另行审批自动清理：

1. 认证由豆包授权或官方客户端代理，CC Switch 不读取 Cookies、token、Keychain 项或浏览器 profile 凭据。
2. 列表接口提供稳定的会话 id、类型、最后活动时间、置顶/归档/项目归属和运行状态。
3. 删除接口支持按精确 id 删除，明确禁止使用 `delete_all`，并有逐项结果或幂等语义。
4. 能确定并排除当前打开、正在生成、待确认、待授权或其他活跃任务。
5. 服务端提供可验证的软删除/恢复窗口，或官方导出形成可恢复备份；否则 UI 必须把不可恢复性作为独立审批风险重新确认。
6. 接口兼容性可机械探测；版本、schema 或能力不匹配时自动清理入口必须禁用。

当前版本不满足这些条件。

## 5. 明确禁止的实现

- 删除或改写 `~/Library/Application Support/Doubao` 下的 IndexedDB、LevelDB、Local Storage、profile 或锁文件。
- 为了修改数据库而强制退出豆包、复制数据库后回写，或绕过正在持有的 LevelDB 锁。
- 把 Agent workspace、sandbox environment、prepared package 当作历史会话删除。
- 从豆包 profile、Cookies、Local Storage、Keychain、进程内存或网络流量提取认证凭据。
- 通过 AppleScript `execute javascript`、Accessibility 点击、DevTools 注入或页面 DOM 自动化执行批量删除。
- 调用 `/samantha/im/conversation/batch_delete`、`/im/conversation/batch_del_user_conv` 或其他未公开内部协议。
- 将 `claude-doubao` 建成独立 provider，造成 Claude 会话重复扫描或重复删除。
- 在真实个人账号上用删除动作做测试或验收。

## 6. 组件与接口设计

新增共享 owner `managedCleanupTargets`，负责检测、展示能力和打开动作；页面只做编排。建议契约：

```ts
type ManagedCleanupTarget = {
  id: "doubao";
  displayName: string;
  scope: "accountSessions";
  installed: boolean;
  managementMode: "external";
};
```

后端只提供两个窄命令：

```text
list_managed_cleanup_targets() -> ManagedCleanupTarget[]
open_managed_cleanup_target(id) -> Result
```

安全约束：

- 后端使用固定 allowlist 将 `doubao` 映射到 `com.bot.pc.doubao`，不接受 renderer 传入任意 bundle id、路径、URL 或 shell 参数。
- 检测和打开失败只返回脱敏错误，不扫描豆包 profile，不记录用户会话标题或 id。
- 非 macOS 平台或应用未安装时返回不可用状态，不执行 shell fallback。
- `managedCleanupTargets` 与现有可删除 `SessionMeta[]` 保持不同类型和不同确认路径，避免后续重构把外部目标误并入批量删除。

## 7. 用户流程

1. 用户打开“清理会话”。
2. 现有 provider 按当前规则计算可删除与活跃会话。
3. 若检测到豆包，界面在独立区域显示“豆包 · 由豆包管理”。
4. 用户点击“在豆包中管理”，CC Switch 激活豆包；CC Switch 的删除确认状态不变。
5. 用户在豆包自己的历史管理界面选择并确认删除，账号同步和错误处理由豆包负责。

该流程没有 CC Switch 侧数据迁移、备份或回滚，因为 CC Switch 不执行删除。豆包内部删除是否可恢复由豆包产品契约决定，CC Switch 不作承诺。

## 8. 测试与机械守卫

实现阶段至少覆盖：

- 后端单元测试：安装检测成功；未安装/非 macOS 失败关闭；未知 id 被拒绝；固定 bundle 映射不接受注入。
- 前端单元测试：豆包只出现在 external managed 区域；不进入 targets、删除计数和 `onConfirm`；打开失败可见且不改变已有选择。
- 回归测试：`claude-doubao` 产生的 Claude 会话仍只出现一次。
- Playwright UI e2e：从真实“清理会话”界面触发 mock 后端打开动作，并验证豆包从未出现在自动删除确认列表。e2e 不启动真实豆包、不操作真实账号。
- contract sentinel：机械断言 `managedCleanupTargets` 与 `SessionMeta` 删除路径隔离，并将检查接入 `scripts/preflight.sh`。

不得用“文件存在”或静态文本存在代替行为断言。

## 9. 验收标准

- 安装豆包的 macOS 用户能从 CC Switch 清理入口进入豆包管理流程。
- 豆包账号会话不会被计入 CC Switch 的自动清理预览，也不会被 CC Switch 删除。
- 豆包正在运行、关闭、未安装或检测失败时均不会触碰其 profile。
- 未知 managed target、恶意路径或 URL 无法通过后端命令打开。
- 现有 Claude、Codex、Cursor 等会话扫描、活跃检测和删除行为保持不变。

## 10. 审批项

本设计请求确认以下决策：

- 目标确认为 Doubao Desktop 账号会话；`claude-doubao` 继续归现有 Claude provider。
- 接受本期“统一入口、豆包内管理”，不承诺 CC Switch 自动删除豆包会话。
- 接受在没有公开接口前永久禁止私有协议、凭据提取、JS 注入和本地数据库删除。

审批通过后再实现本期能力；任何自动删除方案必须重新提交高风险设计并单独审批。
