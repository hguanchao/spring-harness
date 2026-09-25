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

/** 参考 models.json：单个 provider 示例；模型级 api 覆盖演示同一网关三种协议的接法。 */
export const REFERENCE_MODELS_JSON = `{
  "providers": {
    "example-openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "chat-completions",
      "apiKey": "",
      "models": [
        { "id": "gpt-5.2" },
        { "id": "model-responses", "api": "responses" },
        { "id": "model-messages", "api": "anthropic-messages" }
      ]
    }
  }
}
`;

/** 参考 config.toml：指针指向模板里的示例 provider，注释解释两份文件的分工。 */
export const REFERENCE_CONFIG_TOML = `# sph 用户配置(~/.sph/config.toml)。
# 端点与模型的声明在 models.json;这里只回答「用哪个 provider 与哪个模型」。
#
# 快速上手:
#   1. 在 models.json 里把 apiKey 填上——支持 $ENV_VAR 插值,推荐把 key
#      放进环境变量而不是写进文件;baseUrl / models 也换成你自己的;
#   2. 把下面的 provider / model 改成你声明的名字;
#   3. 重新运行 sph。
#
# models.json 的模型条目还支持这些可选字段(JSON 写不了注释,备忘在这里):
#   cost        每百万 token 的美元单价 { input, output, cacheRead, cacheWrite },
#               四项必填;声明后状态栏显示本次会话花费,价格抄 models.dev 或厂商定价页
#   reasoning   false = 该模型不支持推理档位,配置的 effort 不再发送(省一次降级往返)
#   input       接受的输入模态,如 ["text"](纯文本模型);没有 "image" 时图片附件
#               发送前自动降级成说明文本,而不是发出去被端点拒绝
#   name        展示名;contextWindow / maxTokens 分别覆盖上下文窗口与输出上限

provider = "example-openai"
model = "gpt-5.2"

# 常用可选项(注释掉 = 用默认):
# context_window = 256000        # 模型上下文窗口;models.json 里模型未声明时在这里兜底
# max_tokens = 8192              # 单次输出上限
# reasoning_effort = "medium"    # off | low | medium | high | xhigh | max
# approval = "ask"               # ask | auto | yolo
# sandbox = "off"                # off | workspace | read-only
# max_retries = 10               # 上游失败重试次数;0 = 失败即停
# prompt_cache = true            # Anthropic 协议的 prompt-cache 断点
# proxy = ""                     # 出站代理 http(s);显式空串 = 强制直连
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
