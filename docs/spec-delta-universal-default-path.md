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

- 侧栏 **「统一供应商」钉在 App 列表之上**：默认工作台，与 MCP/Skills 等其余全局项分开。
- 无上次视图记忆时，主窗口默认落到 **统一供应商**（`DEFAULT_VIEW`）。
- 「+」预设挑选步在支持统一供应商的 App 上默认选中「统一」分类。
- 保存后自动 `sync`，并对勾选 App 将子 Provider **设为当前**；取消勾选时清理 current 指针。
- 可投影 App 默认勾选：Claude / Codex / Gemini / Pi。
- 可选 `baseUrls` 按应用覆盖 API 地址（Plan 类 Claude/Codex/Pi 路径不同时）。
- Universal sync 投影 Pi 时调用 `model_fetch` 对齐上游模型目录；失败则保留已有/占位目录。

### MODIFIED

- 应用专属预设仍可在挑选步其它分类选用，不再作为默认落点。
- 对齐上游两步添加流；不恢复旧双 Tab。
- 已有 `cc-switch-last-view` 记忆时仍尊重用户上次停留页（含 App 供应商页）。

### REMOVED

- 无。不删除专属供应商、Proxy、模型槽、ModeTabs；不新增「超级 Profile」页。

### 明确不做（本 delta）

- 不重做整站信息架构（App 仓与 Mode 仍在）。
- 不把 Cursor 纳入 Provider 切换。
- 不在本轮扩展 OpenCode / Hermes / Grok / Claude Desktop / mcode 的 Universal 投影（Pi 已纳入）。
- 不用「聚合」冒充跨 App 处处生效。
- 不强制迁移已有 last-view 记忆到统一供应商。

## Scenarios

| 类型 | 场景 | 期望 |
|------|------|------|
| 正向 | 清空 last-view 后启动 | 落到统一供应商页 |
| 正向 | 侧栏最上方点「统一供应商」，新建并勾选 Claude/Codex/Gemini/Pi，保存 | 勾选 App 生成/更新子卡且均为当前（Pi 写入 models.json）；live 已投影 |
| 正向 | 设置 `baseUrls.claude` / `baseUrls.codex`（或 Pi）后同步 | 各子卡使用覆盖 URL，而非共享 `baseUrl` |
| 正向 | App「+」打开挑选步 | 默认落在「统一」分类 |
| 负向 | localStorage 已记 `providers` | 仍打开上次 App 供应商页，不被强制改道 |
| 负向 | 取消勾选某 App 后同步 | 子卡删除且 current 清空；其余 App 不受影响 |
| 负向 | 某 App 写入/启用失败 | 其余成功；失败被明确报告 |
| 回归 | 直连/路由/聚合、专属供应商列表 | 行为不变 |

## Validation

- 自动化：`readStoredView` 默认 `universal`、有记忆时尊重；`sync_universal_to_apps_*`（含 Pi 投影 / scrub）；`universal_provider_base_urls_*`；挑选步默认统一分类；侧栏/导航含 `universal`。
- 手动：冷启动无记忆进统一供应商；侧栏钉顶可见；App「+」默认「统一」；Plan 网关填 per-app baseUrls 后 sync。
- 未验证：某 App 写入/启用失败时的部分成功报告；OpenCode / Hermes / Grok / Claude Desktop / mcode 的 Universal 投影、Cursor Provider 化。
