# 工具调用抽象层（Tool Runtime）能力评估

状态：待决策（评估完成，一个低成本优化候选）
日期：2026-09-24
依据：对照清单逐项代码审计（定位到文件/行）；对标 Pi（容器隔离路线）与端侧编码 agent 的通行形态

背景清单：

- 标准化 Tool 定义（JSON Schema）、工具解析、参数校验、执行代理；
- 支持内置工具 + 外部注册工具（HTTP / 本地函数 / 容器工具）；
- 工具执行沙箱：限制文件读写、网络权限、超时 kill，防止工具越权。

## 一、结论先行

**这也是完成度很高的既有模块**：定义 / 解析 / 执行代理 / 内置与外部注册全部已有，且"执行代理"的实际深度（并行调度按模型序提交、hooks、spill、先读后写观察）超出清单字面。三个真实缺口——容器执行通道、网络 confinement、schema 驱动的通用参数校验——全部是**有意的设计边界**而非遗漏。唯一值得动手的是一个小调优：**MCP `tools/call` 的 15s 硬超时偏紧且不可配**。

## 二、逐项判定

| 清单项 | 判定 | 证据 |
| --- | --- | --- |
| 标准化 Tool 定义（JSON Schema） | ✅ 已有 | `ToolSpec.schema`（`tools/types.ts:80`）声明式 JSON Schema，进请求 tools 数组与提示词段落；工具三处维护约定（实现 / 标志 / TOOL_SECTIONS）见 tool-roadmap |
| 工具解析 | ✅ 已有，fail-closed | 模型参数 JSON 解析失败 → `invalid tool arguments` 回给模型（`loop.ts:993-1001`）；未知工具拒绝；解析错误不中断其余并行调用 |
| 参数校验 | ⚠️ 手写式（有意） | 无通用 JSON Schema 校验器（不引 ajv，5 依赖纪律）；每工具用 `asString`/`asOptionalBool` 等助手在 execute 内校验，错误信息具体到字段，对模型比 schema 报错更可修。schema 是**声明**不是验证器 |
| 执行代理 | ✅ 已有且超出清单 | `runToolBatch`（`tool-run.ts`）：连续 concurrencySafe 成批 `Promise.all`、exclusive 做屏障、**结果按模型序提交**（保证 JSONL / 提示词前缀稳定，部分网关乱序直接 400）；beforeTool/afterTool hooks（可否决）；超长结果 spill 落盘留头尾预览；deny 策略集中一处（`tools/pipeline.ts`），新工具注册不必改循环 |
| 内置工具 | ✅ | sph-tools 12 个：read/write/edit/glob/grep/ls/bash/pwsh/skill/ask_user/web_search/web_fetch |
| 外部注册：本地函数 | ✅ | 插件 `api.registerTool`，三级发现（内置 → 用户级 → 工作区信任后），坏插件降级警告不挡启动 |
| 外部注册：HTTP | ✅ | sph-mcp：stdio / 可流式 HTTP / legacy SSE；五来源发现（含 claude/codex 外部配置）；懒连接 + 热重载 + 本地启停偏好 |
| 外部注册：容器工具 | ❌ 无 | 无 docker/容器执行通道。sph 沙箱是**同机文件策略**（README 明示）；容器隔离是 Pi 推荐的路线（Pi 因此干脆不做审批弹窗），两条路线各有取舍 |
| 沙箱：文件读写限制 | ✅（Windows 部分 enforce） | off / workspace / read-only 三档；Linux bwrap→Landlock 回退、macOS Seatbelt、Windows 受限令牌 + ACL；realpath 边界 + 符号链接不穿透；read-only 拒写可 `escalate` 一次性放行（按路径记授权）；先读后写强制（`FileObservation.denyIfUnseen`） |
| 沙箱：网络权限 | ❌ 设计如此 | README Known limitations："reads and network stay on the host"。无 per-tool 网络策略；Windows 本来就只部分 enforce |
| 沙箱：超时 kill | ✅（一处偏紧） | shell 默认 60s 超时 kill（`host-spawn.ts:23-25` setTimeout kill + Windows deadline/taskkill /T 杀进程树）；AbortSignal 联动（ESC 中断同步生效）；输出封顶（`capSpawnOutput`）；MCP 请求 15s 硬超时（`hub.ts:639-642`）——**含 tools/call，偏紧**，见三.1 |
| 防止越权 | ✅ 三层独立 | 信任门（工作区未信任不读项目插件/AGENTS.md/agents）→ 沙箱 → 审批（REVIEWED_TOOLS 按命令原文记授权键，deny>ask>allow，grants 按 git root 落盘）；工具面收口全 fail-closed：`allowed` 集合 / `rootOnly` / `explore` / `planSafe` 未声明即拒绝（`pipeline.ts:28` 未声明按拦截） |

## 三、优化与取舍

### 1. MCP `tools/call` 超时可配（唯一建议做，半小时）

现状：`hub.request` 对**所有方法**统一 15s 超时（`hub.ts:642`）。initialize/tools/list 15s 合理；但 `tools/call` 打到浏览器自动化、构建、爬取类 server 普遍超过 15s——模型会看到一句干巴巴的 `MCP timeout: tools/call`，任务直接失败。

改法：`[mcp_servers.<name>]` 增加 `call_timeout_ms`（默认放宽到 60s，握手/list 保持 15s）；McpServerConfig 加一个可选字段，McpReloadOptions 透传。改动面：hub.ts 一处 + config 解析 + 测试。

实现记录（2026-09-24）：

- `McpServerConfig.callTimeoutMs`（接缝 `services.ts` 与 hub 各一份，结构等价）；默认 `DEFAULT_MCP_CALL_TIMEOUT_MS = 60s`，控制请求保持 15s。
- **两层同改**：hub `request()` 加超时参数（stdio 的唯一闸门）；remote.ts 每条 POST 的 `AbortSignal.timeout` 按方法选超时（`postTimeoutMs` 纯函数）——否则 http/sse 传输下 hub 放宽、HTTP 层 15s 先掐，配置形同虚设。
- 热重载即生效：超时从 `entry.spec` 现读而非存进 Connection，改配置不要求重连。
- 解析：用户级 `load.ts` 严格校验（非法值拒绝启动）；发现层 `sources.ts` 容忍（非法值警告 + 条目保留），TOML/JSON 两路都认。
- 超时后的迟到回包由 `onRpc` 的未知 id 分支安全忽略。
- 测试：hub 3 例（真子进程 slow 工具）、remote 端到端 1 例 + 纯函数 1 例、sources 解析 1 例、load 严格解析 1 例；fixture 增加 `slow` 工具。

### 2. 通用 JSON Schema 参数校验——观察单

正面价值主要在 MCP：外部 server 的 schema 千奇百怪，通用校验能把模型幻觉参数拦成 `invalid arguments` 而不是打到底层失败。但内置 15 个工具已各自校验且报错更友好；引 ajv 违背依赖纪律，手写 JSON Schema 子集又是新维护面。**等实际观察到 MCP 幻觉参数反复失败再说**。

### 3. 明确不做

| 候选 | 理由 |
| --- | --- |
| 容器执行通道（docker exec 型工具） | 与同机沙箱是两条替代路线而非互补；Windows 上 docker desktop 依赖重；sph 的威胁模型（个人机）没有多租户 |
| 网络 confinement | 已知限制且已声明；Windows 沙箱本身只部分 enforce，网络策略建立在不完整的地基上意义有限；需要时外层套容器/代理是用户侧方案 |
| schema 驱动重写全部内置工具校验 | 手写校验的错误信息（具体字段 + 修正提示）对模型更可修；重写是纯 churn |

## 四、对标注脚

- 清单描述的仍是**托管平台形态**的 tool runtime（"执行代理"、容器工具是云端 sandbox-as-a-service 的词汇）。端侧编码 agent（Claude Code / Codex CLI / sph）的通行形态是：registry + 策略层 fail-closed + 同机沙箱 + 审批——sph 与之一致且策略层更细（planSafe/explore/rootOnly/allowed 四个维度的缺省拒绝）。
- Pi：不做审批弹窗，把"防越权"整体外包给容器隔离。sph 选了进程内策略 + 同机沙箱，粒度更细（按命令原文授权、按路径 escalate），代价是 Windows enforce 不完整（已声明）。
- dsh：工具同样是插件形态，思路同 sph 的 registerTool。
