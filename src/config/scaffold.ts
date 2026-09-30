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
# sandbox_auto_allow = false     # true = 沙箱非 off 时 shell 免审批(见 README 的风险说明)
# subagent_approval = "inherit"  # inherit(复用父会话审批) | strict(受审工具一律拒绝)
# subagent_max_depth = 1         # 子代理嵌套深度;0 = 禁止派生
#
# [permissions]                  # 长期规则。跨层按 deny > ask > allow 求值,先命中先定论
# deny = ["bash(rm *)", "read(~/.ssh/**)", "read(*.env)"]
# ask = ["bash(git push *)", "web_fetch(domain:*.internal.example)"]
# allow = ["bash(npm *)", "bash(git status)", "mcp(context7)"]
#
# 每条是 Tool 或 Tool(specifier)。旧的 tool:pattern 写法已不认。改完要重启才生效。
# 任一层的 deny 都压过所有 allow,两者都压过 approval(包括 yolo)。sph -p 无人可问,
# ask 等于拒绝。ls / git status / cat 这类只读命令默认不问,要拦就写进 ask 或 deny。
#   bash / pwsh      命令前缀:* 含空格,末尾 " *" 也匹配不带参数的命令;:* 只在末尾生效
#                    timeout / nice / nohup / KEY=value 会先剥掉再比
#                    bash(background=true) 匹配参数,shell 只认 background 与 timeout_ms
#   read write edit  路径,gitignore 风格。// 绝对(//C:/secret/**)、~/ 主目录、
#   ls glob grep     / 相对这份配置所在目录,其余相对工作区
#                    ! 否定,只在同一张表内、后写的盖过先写的
#                    deny / ask 的相对模式匹配任意深度;allow 只锚定工作区
#   web_fetch        domain:主机;*.example.com 匹配子域,不匹配根域本身
#                    web_search 同样吃 domain:
#   mcp              mcp(server) 或 mcp(server.tool)
# 工具名可通配,且只在 deny / ask:deny = ["mcp*"]。allow 必须写字面工具名。
# 裸工具名 deny(deny = ["bash"])把该工具从模型上下文整个移除。
# 同一份规则可写到 <项目>/.sph/config.toml,该文件只认 [permissions] 与 [mcp_servers];
# 工作区未信任时,项目级 allow 整段不生效,deny / ask 照常生效。
# 预览一条命令:sph rules check "npm test";会话里看生效结果:/permissions
#
# 「这个动作以后别再问」不写在这里。审批弹窗的 always allow 记到
# <项目>/.sph/permissions.json(按具体动作,首次写入时加入 .gitignore)。
# always allow rules like this 会把建议的前缀规则追加进项目级 [permissions].allow。
# config.toml 里的 [grants] 已不再读取;表里还有内容时,启动会警告一次。

# ── 用量与预算 ────────────────────────────────────────────────────────────────
# max_turns = 20                 # 子代理的模型调用上限;省略时子代理默认 20 步,根会话不封顶
# max_session_tokens = 0         # 会话 token 预算(prompt+completion,含子代理);0 = 不限
# spill_threshold = 8192         # 工具结果超过这个字符数落盘,上下文只留预览;0 = 关闭

# ── 界面 ──────────────────────────────────────────────────────────────────────
# [ui]                           # 界面行为;/notify 写的就是这一张表
# notify = "auto"                # auto(响铃+桌面通知) | bell(只响铃) | desktop(只桌面通知) | off
# notify_after_seconds = 10      # 焦点还在本终端时,一段等待至少要跑够这么久才提醒;0 = 完成就提醒
#                                # 一轮跑完、后台任务交付、/compact 收尾时提醒一次;终端不接
#                                # 桌面通知时 auto 自动只剩响铃。用户主动 Esc/Ctrl+C 中断不提醒。
#                                # 焦点不在本终端时上面这条秒数不算,一定提醒。

# ── MCP ───────────────────────────────────────────────────────────────────────
# 启用的 server 一律在启动时后台连接,不等谁;连不上的进 /mcps 的报错清单,不挡启动。
#
# [mcp_servers.context7]         # stdio 型:本地进程
# command = "npx"
# args = ["-y", "@upstash/context7-mcp"]
#
# [mcp_servers.docs]            # http 型:远程端点(type = "sse" 走旧 SSE)
# type = "http"
# url = "https://example.com/mcp"
# headers = { Authorization = "Bearer $DOCS_KEY" }
# call_timeout_ms = 120000       # 只作用于 tools/call;控制请求固定 15s
# disabled = false               # true = 不连接(默认 false);写一条只有 disabled 的同名条目
#                                # 即可关掉外部配置(~/.claude.json 等)里声明的 server

# ── 插件与运行时状态 ──────────────────────────────────────────────────────────
# [plugins]
# disabled = ["sph-sandbox"]     # 关掉的插件;默认全装
#
# trusted = []                   # 已信任的工作区根;--trust 与信任页会自动回写,不必手填
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
