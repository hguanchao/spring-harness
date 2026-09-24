# 统一模型后端适配器（Model Gateway）能力评估

状态：待决策（评估完成，无必须新增项）
日期：2026-09-24
依据：对照清单逐项代码审计（定位到文件/行）；对标 Pi（pi-ai 统一协议层）与 LiteLLM/网关类平台组件的形态

背景清单：

- 抽象 LLM / 多模态模型接口，屏蔽 OpenAI、DeepSeek、Claude、本地 Ollama 等差异；统一入参出参、流式返回。
- 内置重试、超时、熔断、模型自动降级；支持 token 计数、速率限制。

## 一、结论先行

**这是清单里完成度最高的一项。** 前半（抽象 / 统一 / 流式）已完全实现；后半的重试 / 超时 / token 计数不仅已实现，实际深度超出清单（错误归一化、额度识别、Retry-After、缓存位、跨厂商辅助路由）。真正缺的只有**熔断、模型级故障转移、主动限速、多模态扩展**四件——全部是平台向（API 网关 / 多租户）组件，在单用户个人 runtime 的尺度上，多数不该做。

sph 模型层的形态与 Pi 的 pi-ai 同构：按**线协议**适配而非按厂商适配——3 个协议适配器（chat-completions / anthropic-messages / responses）覆盖了清单点名的全部厂商：

- OpenAI → chat-completions / responses
- DeepSeek → chat-completions（OpenAI 兼容端点，models.json 声明 baseUrl 即接入）
- Claude → anthropic-messages
- Ollama → chat-completions（OpenAI 兼容端点，指向 localhost）

按厂商写适配器的思路（清单字面义）反而是反模式：每接一家多一份维护，而所有 OpenAI 兼容端点共享同一条代码路径。

## 二、逐项判定

| 清单项 | 判定 | 证据 |
| --- | --- | --- |
| 抽象 LLM 接口，屏蔽厂商差异 | ✅ 已有 | `LlmClient` 接缝（`llm/client.ts:69-77`）：core 零实现，循环和宿主只依赖这一面；适配器全部在 sph-llm，禁用插件即消失 |
| 屏蔽 OpenAI/DeepSeek/Claude/Ollama | ✅ 已有 | 三协议适配器 + `models.json` providers 声明 `baseUrl`/`api`（provider 级可被 model 覆盖）+ `apiKey` 支持 `$VAR` 插值 + 自定义 headers。任何 OpenAI 兼容端点（含 Ollama 本地、各类中转站）零代码接入 |
| 统一入参出参 | ✅ 已有 | 统一 `ChatMessage`（`client.ts:27-43`，含 tool_calls / thinking 回放 / reasoning 项）；响应侧字段并集归一化（`aliases.ts`）：`reasoning_content`/`reasoning`/`thinking`、`prompt_tokens`/`input_tokens`、`cached_tokens`/`prompt_cache_hit_tokens` 等多家键名各取第一个非空 |
| 流式返回 | ✅ 已有 | `StreamDelta` 流式（text / thinking / toolCalls / usage）；SSE 解析含断流重打（`sse.ts`，Anthropic/中转站直接关连接按抖动处理） |
| 重试 | ✅ 已有且超出清单 | `retry.ts`：408/429/5xx + 网络错 + 空闲超时 + 空响应可重试；指数退避加抖动封顶 20s；**尊重 Retry-After（封顶 60s）**；额度用尽识别为 QUOTA 不做无意义重试（`errors.ts:66-72`）；**流已向用户吐字后不重试**（避免重复吐字）；`max_retries` 可配（默认 10） |
| 超时 | ✅ 已有 | SSE 空闲超时（默认 120s）+ 首字节超时，均可配（`sse.ts:11,25-28`）；重试 sleep 可被 AbortSignal 打断 |
| 熔断 | ❌ 无 | 无 provider 级健康跟踪 / 失败闸门。重试是请求级的。单用户单进程场景熔断防的「持续打已故障上游」由「退避重试 + 上抛 + 人切 /model」覆盖 |
| 模型自动降级 | ⚠️ 需拆开说 | **参数级自动降级 ✅ 已有**：端点拒绝 `max_tokens`/`stream_options`/缓存位等可选参数 → 按 400 报文剥字段重发（`compat.ts` + `stream-client.ts`），会话内记忆不再踩，`compat_retry` 事件留痕。**模型级故障转移 ❌ 无**：A 模型挂了不会自动切 B。已有的等价物是手动的：`/model`、`/provider` 热切换 + `[aux]` 把压缩/审查路由到另一家便宜端点 |
| token 计数 | ✅ 已有 | 服务端 usage 归一化（`TokenUsage` 含 `cachedTokens`）；`estimateTokens` 字节级估算器（预算判断够用，无本地 tokenizer）；`max_session_tokens` 整代理树预算 + 80% 预警；usage 事件逐请求落盘、按子代理累计 |
| 速率限制 | ⚠️ 拆两面 | 被动侧（尊重上游 429 + Retry-After + 退避）✅；主动侧（客户端自限速 RPM/TPM 闸门）❌ 无。单用户打自己的 key，429+Retry-After 就是最优响应，自限速只徒增延迟 |
| 多模态 | ⚠️ 部分 | 输入侧图片 ✅（`@` 附件转 data URL 走 `userImages` 通道，`ContentPart.image_url`）；音频/视频/图片生成 ❌ 无 |

超出清单但值得记录的既有能力（评估时容易漏）：

- **错误归一化**：HTTP 状态 → 稳定码（AUTH/RATE_LIMIT/QUOTA/CONTEXT_WINDOW_EXCEEDED/…）；上下文超窗跨协议措辞识别（含中转站自然语言措辞），命中后 loop 压缩重试而非报错；流中途 error 帧区分「终态」（审核/鉴权/参数/额度）与「传输抖动」。
- **提示缓存位**：Anthropic 缓存断点 + OpenAI `prompt_cache_key`，被拒自动撤；prefix 稳定性跟踪（`cache_miss` 留痕）。
- **跨厂商辅助路由**：`[aux].provider` 把摘要/审查发到另一家端点，省主模型用量。

## 三、要不要补

**建议做：无。** 没有一个缺口达到 lifecycle 清单里「task 取消」那样的证据强度。

**观察单（等真实痛点）：**

- **模型级故障转移**——唯一有潜在用户价值的：中转站不稳是常态，`models.json` 给模型声明 fallback 链，主模型连续不可重试失败（QUOTA/AUTH 除外）→ 自动切备用并出 status 提示。成本中等：stream-client 外加一层 failover 决策 + 配置声明 + 事件。触发条件：实际观察到「端点挂了只能手切」的频率。
- **多模态输入扩展**（PDF 等）——等真实需求，纯加 `ContentPart` 变体 + 附件通道，随时可做。

**明确不做：**

| 候选 | 理由 |
| --- | --- |
| 熔断器 | 防的是多租户下持续打已故障上游；单用户单进程里退避重试 + 上抛 + 手动切换已覆盖同一场景。引入健康状态机 = 新增一套要测的状态 |
| 主动限速（RPM/TPM 闸门） | 单用户打自己的 key：上游 429 + Retry-After 是权威信号，客户端自猜阈值只会白等。LiteLLM 需要它是因为代理后面有 N 个用户共享配额 |
| 本地 tokenizer（tiktoken 等） | 字节估算对「要不要压缩」的判断够用；加依赖违背 5 依赖原则，且各家分词器互不通用 |
| 按厂商写适配器 | 三协议已覆盖全部 OpenAI 兼容端点；每厂商一份适配器是维护负资产 |
| 多模态输出 / 音频 | 无使用场景；编码 agent 的模态需求集中在图 |

## 四、对标注脚

- Pi 的 pi-ai：同为「按线协议归一化」的多 provider 层（4 协议 / 15+ provider）——sph 的 sph-llm 与之同构，规模更小（3 协议）。
- LiteLLM proxy / one-api 等「Model Gateway」：熔断、failover、限速、配额、计费是它们的核心卖点——那是**代理服务**的职责清单，不是端侧 client 的。清单后半描述的其实是把 LiteLLM 塞进 CLI，sph 不需要。
- dsh：模型也是 Cordis 插件（与 sph 的 MODEL_SERVICE 接缝同思路），未见平台网关特性。

## 五、优化审视（2026-09-24 追加：对"已有实现还有什么可优化"的回答）

对 LLM 层做了代码级审计（sse / stream-client / retry / errors / aliases / openai 累积器 / prefix-tracker / compact 估算）。结论：**没有值得现在动手的优化**——关键路径上能想到的优化几乎都已实现：

- 增量 wire 投影（不全量重建）、per-message 字节数 WeakMap 缓存（`compact.ts:87`）、hash 输入 8KB 截断（`prefix-tracker.ts:43`）、早退时 `reader.cancel()` 防连接泄漏（`sse.ts:267-273`）、首字节/空闲双超时、降级次数上限防死循环、per-client compat 记忆不重复交学费。
- 估算漂移已解决：`estimatePromptTokens` 用「上次真实 usage + 锚点后增量估算」而非全程字符估算（`compact.ts:519-529`），压缩时机不随分词口径漂移。

剩余候选项与不做的理由：

| 候选 | 量化后判定 |
| --- | --- |
| 前缀 hash 增量化（每步对全部消息重 hash，O(N)/步） | 8KB 截断下 N=500 约 10-20ms/步，相对秒级 LLM 调用不可见；且 compaction 在 80% 水位触发，N 很难到大。收益趋零 |
| 传输重试间不重建 body（caps 未变时跳过 `buildBody`） | 省一次整对话 JSON.stringify（毫秒级），每轮至多 10 次。不值得为此改循环结构 |
| 请求总时长上限（防"每 119s 滴一个 chunk"的病态流） | 现有 idle 120s 已覆盖真实断流；病态滴流可用 ESC/Ctrl+C 人工中断。加总上限反而可能误杀长思考的稀疏输出 |
| 断流半截的 usage 记账（流断在 usage 帧之前时该次用量丢失） | 仅影响 `max_session_tokens` 预算的精确度（略低估），且断流本身是异常路径。不值得为预算精度增加协议复杂度 |

宏观层面真正的"优化杠杆"都已存在且是配置级：`[aux]` 跨厂商路由（降本）、`prompt_cache`（缓存位 + 前缀稳定性设计）、`--effort`（质量/成本档位）、`spill` 溢出落盘（上下文瘦身）、`max_retries`（可用性/延迟权衡）。
