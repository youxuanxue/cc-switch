# Pi 供应商逐项实测记录

实测时间：2026-10-13T17:06:23

通过实际 `wts open <已有隔离 worktree> pi` 启动已安装的 Pi 1.2.0。使用私有临时 agent 目录中的原生 models/auth 副本和逐供应商默认项；没有通过命令参数强选 provider/model。核对 Pi 返回的实际 provider、model、停止原因和 `PI_SMOKE_OK` 回复。禁用工具、MCP、扩展、上下文文件和会话保存，以隔离供应商连接行为。

| 供应商 | 实测模型 | 普通请求 | 请求 low | 备注 |
| --- | --- | --- | --- | --- |
| tokenkey-ark | ark-code-latest | PASS | PASS |  |
| tokenkey-cn | deepseek-v4-flash | PASS | PASS |  |
| tokenkey-gemini | gemini-2.5-flash | PASS | PASS | gemini-3.6-flash 返回404；2.5-flash原配置low返回400；模型级关闭不支持的reasoning_effort后通过。low在此不代表可控制思考预算。 |
| tokenkey-minimax | minimax-m3 | PASS | PASS |  |
| tokenkey-openai | gpt-6-astra | PASS | PASS |  |
| tokenkey-xai | grok-4.3 | FAIL | 未验证：普通请求已失败 | grok-4.3及grok-4.5均429 no_available_accounts；实时目录无grok条目。未继续重试。 |
| tokenkey.dev | claude-sonnet-5 | PASS | PASS |  |
| Ali Token Plan 个人版 | deepseek-v4.1-flash | PASS | PASS |  |
| tokensea | gpt-6-luna | PASS | PASS | low首次60秒超时；单独复测16.7秒收到回复。存在波动。 |
| Volcengine Agent Plan 个人版 (6) | ark-code-latest | PASS | PASS |  |

## 配置修复与保留

- 已验证并修复六个 tokenkey provider 的 `thinkingFormat`：`reasoning_effort` → `openai`，原生文件与 CC Switch 保存项一致。
- 仅对已实测的 `tokenkey-gemini/gemini-2.5-flash` 设置模型级 `compat.supportsReasoningEffort=false`；其余模型未猜测或批量修改。修复前后均有私有备份。
- 所有实测使用临时副本，各轮的原始 models/settings/auth 字节一致检查通过；修复是单独、显式的操作，未修改默认供应商/模型。
- `wts --self-test` 通过，包括Pi参数、别名、无模型参数和已有工作区打开。

## 验证范围

每家验证一个配置中存在的聊天模型，另对失败项换模型/复测；不是所有目录模型逐项通过。非聊天模型、工具调用、多轮会话、所有思考档位、CC Switch桌面点击切换及项目级覆盖尚未在本轮验证。本记录属于真实CLI/服务集成测试，不称为UI e2e。上游429/404与不稳定请求保留为失败/风险。

## 可复用验证

`scripts/verify-pi-live.py` 是显式调用的live验证入口，不进入preflight，不输出凭据或原始日志。使用 `--case provider=model` 明确每家实测模型，`--only provider` 做针对性复测，`--thinking off|low` 切换请求档位；缺失provider或空目录会失败。会消费供应商额度。

逐轮证据合并在 [pi-live-smoke-20261013.json](pi-live-smoke-20261013.json)，保留首次失败和后续复测结果。
