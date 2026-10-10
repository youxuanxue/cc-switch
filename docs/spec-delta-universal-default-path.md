# 统一供应商作为默认配置路径

## Background

主界面按 App 分仓配置，用户需对 Claude / Codex / Gemini 等逐个添加并启用同一张供应商卡，与「一处配置、处处生效」相反。

产品内已有承接件，无需新实体：

- `UniversalProvider` + `sync_universal_to_apps`（意图 SSOT）
- 各 app 的 live adapter（落盘微调）
- Local Proxy（可选运行时：热切换 / 协议转换 / failover）

问题在默认路径：专属供应商是主入口，统一供应商被藏在次级 Tab。

## Delta

### ADDED

- 默认「+」进入**统一供应商**创建流：名称、API Key、Base URL、勾选目标 App。
- 保存后自动 `sync`，并对勾选 App 将对应子 Provider **设为当前**（普通 switch 或已接管时的 proxy hot-switch）。
- 可投影的 App **默认勾选**（首期：Claude / Codex / Gemini）。

### MODIFIED

- 「应用专属供应商」降为高级入口，不再作为快速上手默认路径。
- App Switcher 定位为查看投影 / 改例外，而非主配置入口。

### REMOVED

- 无。不删除专属供应商、Proxy、模型槽或 adapter；不新增「超级 Profile / 全局配置中心」页面。

### 明确不做（本 delta）

- 不重做整站信息架构。
- 不把 Cursor 纳入 Provider 切换。
- 不在本轮扩展 OpenCode / Hermes / Pi / Grok / Claude Desktop 的 Universal 投影（后续可加）。

## Scenarios

| 类型 | 场景 | 期望 |
|------|------|------|
| 正向 | 新建统一供应商，勾选三家，保存 | 三家各生成/更新 `universal-{app}-{id}`，且均为当前；live 已投影 |
| 正向 | 修改 Key / URL 后保存 | 勾选 App 的子 Provider 与 live 同步更新 |
| 负向 | 取消勾选某 App 后保存 | 该 App 子 Provider 删除或不再由该 Universal 驱动；其余不受影响 |
| 负向 | 某 App live 写入失败 | 其余 App 仍同步成功；失败被明确报告（非整体假成功） |
| 回归 | 已有专属供应商列表 / 切换 / Proxy 接管 | 行为不变，仍可从高级入口使用 |

## Validation

- 自动化：
  - `sync_universal_to_apps_activates_enabled_child_when_not_current`
  - `sync_universal_to_apps_removes_disabled_child_provider`
  - `AddProviderDialog`「默认打开统一供应商 Tab」
- 手动：主界面「+」默认落在统一供应商；完成后无需再逐 App 点启用即可在对应 CLI 验证（按既有生效方式：Claude/Gemini 即时，Codex 视热重载/重启）。
- 未在本 delta 验证：非三家 App 的 Universal 投影、Cursor Provider 化。
