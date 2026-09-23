# 工具集扩展建议

状态：待决策（尚未实现）
日期：2026-09-20
依据：本轮工具层全面审计（含沙箱实测与复现验证）

## 一、现状盘点

核心工具：`read` `write` `edit` `glob` `grep` `ls` `bash` `pwsh` `skill` `ask_user` `web_search` `web_fetch` `jobs`。
`mcp`、`todo`、`enter_plan_mode`、`exit_plan_mode`、`subagent`、`send_subagent_message` 由内置插件注册（`sph-mcp`、`sph-todo`、`sph-plan`、`sph-subagent`）。

### 新增一个工具的真实成本

在这个仓库里，一个工具要在 **3 处**维护：

1. `src/tools/<name>.ts` —— 实现本身；
2. `src/tools/index.ts` —— `concurrencySafe` / `explore` / `rootOnly` 三个标志（当前 19 个工具中 15 个有显式标志）；
3. `src/agent/prompt.ts` 的 `TOOL_SECTIONS` —— 面向模型的使用说明（当前 19 段，与工具一一对应）。

再加上工具 schema 每轮请求都进 system prompt，占用固定前缀预算——多一个工具就是每一轮都多付一次。
**结论：宁可少加。下面的推荐按证据强度排序，不建议的一节同样重要。**

## 二、建议新增

### 1. `git`（证据最充分，建议优先做）

理由全部来自实测：

- **沙箱内 git 能跑，bash 不能。** `sandbox=workspace`（默认档位）下 `git.exe log` 实测 exit 0、
  中文输出完好；而 Git Bash / MSYS 必死于 `CreateFileMapping ... Win32 error 5`。
  即：git 能力在默认配置下目前只有一条走不通的通道。
- **现在的失败路径就是它。** 模型想跑 `git log` → 走 bash → 解析到 `C:\Windows\System32\bash.exe`
  （WSL 启动器）→ exit 1 加一串 `?????`。有 git 工具就不会走到这条路上。
- **每次 git 读操作都在过审批。** `REVIEWED_TOOLS` 含 `bash`/`pwsh`，`approvalScopeKey` 按命令
  原文记键，所以 `git status` / `git diff` / `git log` 这些纯读操作每次都要弹窗或预授权。
  做成工具后读操作可标 `concurrencySafe` + `explore`（子代理只读探索也能用），只把写操作留给审批。
- **输出更省 token。** 结构化摘要（分支、改动文件数、增删行、状态位）比原始文本更短也更好判读。

**实现约束（关键，不可省）：**

- 硬编码白名单子命令、固定 argv，**永不拼接 shell 字符串**。
- **不透传 `-c` / `--config`**：git 配置注入可执行任意命令。
- **禁用 pager 与别名**（`--no-pager`、`-c core.pager=` 之类都不该来自模型输入）。
- 视 hooks / textconv 的风险面决定是否需要在沙箱内执行——它们同样是执行通道。

形状可参考 dynamic-workflow facade 的 `git.*`（`changedFiles` / `diff` / `status` / `log`），
它就是"固定 argv、单一 ref、无 shell 字符串"的现成正确范式。

### 2. `move` / `delete`（一并做，安全收益明确）

现状：删除与重命名**只能**通过 shell 表达——最危险的一类操作走最不安全的通道
（需要 bash 可用、每次拼命令行、只能按命令原文授权）。

权限层已经准备好：`approvalScopeKey` 对 `escalate` 就是按具体路径记键，正好匹配"删这个路径"的粒度。

**实现要点：**

- 接 `assertInsideWorkspace` 做边界检查。
- 接 `FileObservation`：删除 / 移动后要让记账同步，否则同轮后续 edit 的"先读后写"判断会失真。

### 3. `edit_many`（批量编辑）

重构的主要成本是同一批改动要 N 次往返（每次一个 `old_string`）。批量 edit 在 token 和延迟上
都是实打实的收益，也是同类 agent 的标配。

**必须定的语义：要么全成功、要么全不改（原子性）**，不要"改一半"。部分应用会让工作区停在
不一致状态，比整体失败难排查得多。

### 4. `read_url`（补"读不了网页"的缺口）

`web_fetch` 实际只回 280 字正文（`htmlSnippet` 里 `slice(0, 280)`），是标题 + 摘要预览，
**不是网页阅读器**——查文档、读 issue、看 changelog 都会失败。

两种改法：

- 新增 `read_url`，返回 clip 到 token 预算的正文；保留 `web_fetch` 的轻量语义（快速判断相关性）。
- 或直接把 `web_fetch` 改成返回正文（不推荐：会让返回长度不可预测，两种用途混在一个工具里）。

### 5. `verify`（发现并跑项目自己的校验）

对应 AGENTS.md 的"代码必须可编译；有构建环境时先自行编译验证再交付"，以及 workflow facade 的
"先找仓库已定义的检查，再决定跑什么"。

价值主要在**发现**：读 `package.json` scripts / gradle / maven / Makefile，挑出正确的检查命令，
配对超时与通过标准，而不是让模型每次猜。

**注意**：它与 `bash`/`pwsh` 有功能重叠。加不加取决于是否经常观察到模型跑错校验命令——
这条缺少像 `git` 那样硬的证据，优先级低于前四条。

## 三、明确不做

| 候选 | 不做的理由 |
| --- | --- |
| 截图 / 桌面控制 | 超出编码 agent 职责边界，且平台专属，维护成本换不来对应价值 |
| 改配置 / 加 MCP server 的工具 | 让模型能改自己的配置面，而配置里有 api_key——安全边界划不来 |
| 记忆写入工具 | `AGENTS.md` 用 `edit` 就够了，专门开工具只是多一条"悄悄改指令文件"的通道 |
| `sleep` / `wait` | jobs 已是推送语义，加了只会诱导模型去轮询等待 |
| MCP resources / prompts | 等有真实使用场景再说，现在加是猜测性设计 |
| checkpoint / undo | 价值认同，但这是 **harness 层特性**（按轮快照文件内容），不是模型工具，工程量是另一个量级 |

## 四、落地顺序

1. **`git`** —— 理由最充分、边界最清楚，还能立刻消掉"bash 跑 git"这条死路。
2. **`move` / `delete`** —— 消除"危险操作只能走 shell"的错配，权限层已就绪。
3. **`edit_many`** —— 纯效率收益，需要先定原子性语义。
4. **`read_url`** —— 补能力缺口，需在"新工具"与"改 web_fetch"之间做选择。
5. **`verify`** —— 证据不足，等观察到实际痛点再定。

前两条合计约一天工作量。

## 五、相关但独立的遗留问题

- `npm run lint` 跑不了：`package.json` 声明了 `biome lint`，但 `node_modules` 里没有 biome bin，
  依赖未安装。与本路线图无关，但应当补齐。
- `read` 会把 UTF-16LE 文本文件判为二进制拒读（NUL 字节嗅探），Windows 记事本另存的文本即是此编码。
  修法（加 BOM 检测或 UTF-16 解码路径）改动面较大，待确认是否真有需求。
