/**
 * 首次运行的用户配置脚手架。
 *
 * 安装后 ~/.sph 里什么都没有，直接启动只会得到「provider must be a non-empty string」
 * 这类没头没尾的报错。这里在入口处检查两份配置：缺哪份补哪份，已有的**绝不覆盖**——
 * 里面是用户手写的选择，模板没有资格覆盖它。
 *
 * models.json 模板必须能被 parseRegistry 原样解析：apiKey 留空串而不是编一个占位
 * 假 key——空串在这个代码库里是「故意免鉴权」的保留字面量，loadConfig 会在启动时
 * 点名要求填 key，而不是等第一次请求带着假 key 吃 401。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sphConfigPath, sphHome, sphModelsPath } from '../home.js';

/** 参考 models.json：provider 级与模型级的全部字段各出现一次,三种协议各演示一个模型。 */
export const REFERENCE_MODELS_JSON = `{
  "providers": {
    "example-openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "chat-completions",
      "apiKey": "$OPENAI_API_KEY",
      "headers": {
        "X-Title": "Spring Harness (sph)"
      },
      "compat": {
        "prompt_cache_key": true,
        "prompt_cache_retention": false,
        "stream_options": true,
        "session_affinity": "off"
      },
      "models": [
        {
          "id": "gpt-5.2",
          "name": "GPT-5.2",
          "contextWindow": 400000,
          "maxTokens": 128000,
          "cost": { "input": 1.25, "output": 10, "cacheRead": 0.125, "cacheWrite": 0 },
          "reasoning": true,
          "input": ["text", "image"]
        },
        { "id": "model-responses", "api": "responses" },
        { "id": "model-messages", "api": "anthropic-messages" }
      ]
    }
  }
}
`;

/** 参考 config.toml：全部配置段与选项各出现一次(可选项以注释呈现),注释即使用手册。 */
export const REFERENCE_CONFIG_TOML = `# sph 用户配置(~/.sph/config.toml)。
# 端点与模型的声明在 models.json;这里只回答「用哪个 provider 与哪个模型」。
#
# 快速上手:
#   1. 在 models.json 里把 apiKey 换成你的 key——模板里的 $OPENAI_API_KEY 是
#      环境变量占位(设好变量即可,未设变量会拒绝启动),也可以直接写字面量;
#      baseUrl / models 也换成你自己的(cost 示例数字仅演示格式,按厂商定价页填);
#   2. 把下面的 provider / model 改成你声明的名字;
#   3. 重新运行 sph。

provider = "example-openai"
model = "gpt-5.2"

# ── 模型与请求 ────────────────────────────────────────────────────────────────
# context_window = 256000        # 模型上下文窗口;models.json 里模型未声明时在这里兜底
# max_tokens = 8192              # 单次输出上限
# reasoning_effort = "medium"    # off | low | medium | high | xhigh | max
# max_retries = 10               # 上游失败重试次数;0 = 失败即停
# prompt_cache = true            # Anthropic 协议的 prompt-cache 断点
# proxy = ""                     # 出站代理 http(s);显式空串 = 强制直连
# compact_model = "..."          # 压缩摘要专用模型(provider 内的模型 id);省略用主模型
# review_model = "..."           # auto 审批审查器专用模型;省略用主模型
#
# [aux]                          # 辅助调用(压缩/审查)走别的 provider 时声明
# provider = "another-provider"

# ── 权限与安全 ────────────────────────────────────────────────────────────────
# approval = "ask"               # ask | auto | yolo
# sandbox = "off"                # off | workspace | read-only
# subagent_approval = "inherit"  # inherit(复用父会话审批) | strict(受审工具一律拒绝)
# subagent_max_depth = 1         # 子代理嵌套深度;0 = 禁止派生
#
# [permissions]                  # 长期规则,按顺序先匹配先生效;pattern 支持 * 和 ?
# allow = ["bash:npm *", "bash:git status"]
# ask = ["bash:curl *"]
# deny = ["bash:rm *"]

# ── 用量与预算 ────────────────────────────────────────────────────────────────
# max_turns = 0                  # 一轮的模型调用上限;省略不限制
# max_session_tokens = 0         # 会话 token 预算(prompt+completion,含子代理);0 = 不限
# spill_threshold = 8192         # 工具结果超过这个字符数落盘,上下文只留预览;0 = 关闭

# ── MCP ───────────────────────────────────────────────────────────────────────
# [mcp_servers.context7]         # stdio 型:本地进程
# command = "npx"
# args = ["-y", "@upstash/context7-mcp"]
#
# [mcp_servers.docs]            # http 型:远程端点(type = "sse" 走旧 SSE)
# type = "http"
# url = "https://example.com/mcp"
# headers = { Authorization = "Bearer $DOCS_KEY" }
# call_timeout_ms = 120000
#
# [mcp]                          # 本地启停偏好(外部配置里的 server 也管得到)
# disabled_servers = []
# enabled_servers = []
# lazy_servers = []              # 首次使用才连接的重型 server

# ── 插件与运行时状态 ──────────────────────────────────────────────────────────
# [plugins]
# disabled = ["sph-sandbox"]     # 关掉的插件;默认全装
#
# trusted = []                   # 已信任的工作区根;--trust 与信任页会自动回写,不必手填
# [grants]                       # 已批准的授权(作用域 → 动作键);运行时自动回写
`;

/**
 * 缺哪份补哪份，返回本次实际生成的路径。homeDir 可注入（测试用）；
 * 真实运行里这就是 ~/.sph。
 */
export function scaffoldUserHome(options: { homeDir?: string } = {}): string[] {
  const home = options.homeDir ?? sphHome();
  mkdirSync(home, { recursive: true });
  const modelsPath = options.homeDir === undefined ? sphModelsPath() : join(home, 'models.json');
  const configPath = options.homeDir === undefined ? sphConfigPath() : join(home, 'config.toml');
  const created: string[] = [];
  if (!existsSync(modelsPath)) {
    writeFileSync(modelsPath, REFERENCE_MODELS_JSON, 'utf8');
    created.push(modelsPath);
  }
  if (!existsSync(configPath)) {
    writeFileSync(configPath, REFERENCE_CONFIG_TOML, 'utf8');
    created.push(configPath);
  }
  return created;
}
