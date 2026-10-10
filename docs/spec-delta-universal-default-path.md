# 统一供应商作为默认配置路径

## Background

Plan A 壳把导航改成侧栏按 App 分仓，并把直连 / 路由 / 聚合做成每 App 的连接策略。这改善了「怎么连」，但凭据仍按工具拆开——与「一处配置、处处生效」相反。

承接件不变，无需新实体：

- `UniversalProvider` + `sync_universal_to_apps`（意图 SSOT）
- 各 app live adapter / Mode（落盘与运行时微调）
- Local Proxy（可选热切换 / 协议转换 / failover）

直连 / 路由 / 聚合保持 per-App 适配层，不升成跨 App 配置首页。

## Delta

### ADDED

- 侧栏全局页 **「统一供应商」**：与 MCP / Skills 同级的一等入口，可列表 / 添加 / 同步 / 删除。
- 「+」预设挑选步在支持统一供应商的 App 上默认选中「统一」分类。
- 保存后自动 `sync`，并对勾选 App 将子 Provider **设为当前**；取消勾选时清理 current 指针。
- 可投影 App 默认勾选（首期：Claude / Codex / Gemini）。

### MODIFIED

- 应用专属预设仍可在挑选步其它分类选用，不再作为默认落点。
- 对齐上游两步添加流；不恢复旧双 Tab。

### REMOVED

- 无。不删除专属供应商、Proxy、模型槽、ModeTabs；不新增「超级 Profile」页。

### 明确不做（本 delta）

- 不重做整站信息架构。
- 不把 Cursor 纳入 Provider 切换。
- 不在本轮扩展 OpenCode / Hermes / Pi / Grok / Claude Desktop / mcode 的 Universal 投影。
- 不用「聚合」冒充跨 App 处处生效。

## Scenarios

| 类型 | 场景 | 期望 |
|------|------|------|
| 正向 | 侧栏打开统一供应商，新建并勾选三家，保存 | 三家生成/更新子卡且均为当前；live 已投影 |
| 正向 | App「+」打开挑选步 | 默认落在「统一」分类 |
| 负向 | 取消勾选某 App 后同步 | 子卡删除且 current 清空；其余 App 不受影响 |
| 负向 | 某 App 写入/启用失败 | 其余成功；失败被明确报告 |
| 回归 | 直连/路由/聚合、专属供应商列表 | 行为不变 |

## Validation

- 自动化：`sync_universal_to_apps_*`、挑选步默认统一分类、侧栏/导航含 `universal` 全局页。
- 手动：侧栏进入统一供应商页完成添加；App「+」默认「统一」；无需再逐 App 点启用。
- 未验证：非三家 App 的 Universal 投影、Cursor Provider 化。
