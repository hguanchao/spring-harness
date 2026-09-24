# Agent 实例生命周期能力评估（对照 dsh / Pi）

状态：三、四两节已决策；「task 取消」与「todo 剔除」于 2026-09-24 实现（TUI 取消键除外，见三.1）
日期：2026-09-24
依据：对照清单逐项代码审计（定位到文件/行）；对标 DeepSeek Harness（dsh，开发者预览）与 Pi（pi.dev）的公开能力面

背景清单（来自需求侧）：

- 实例创建 / 销毁 / 暂停 / 恢复；多实例并行、隔离沙箱；单会话上下文持久化、会话重置。
- 区分无状态 / 有状态 Agent，会话隔离，防止上下文串扰。

## 一、对标定位：三个 harness 各站在哪里

| | Pi | spring-harness (sph) | DeepSeek Harness (dsh) |
| --- | --- | --- | --- |
| 定位 | 极简个人编码 agent | 单进程通用 agent runtime | 团队级插件平台 |
| 核心形态 | 4 工具（read/write/edit/bash）+ <1k token 系统提示词；子代理、MCP、审批、计划、后台任务**全部不进核心**，靠 TS 扩展按需加 | 插件化 core + 13 个内置插件；子代理 / MCP / 计划 / 沙箱 / 审批内建，接缝全在 `plugins/services.ts` | Cordis 内核 + "一切皆插件"（模型/工具/技能/会话/沙箱/存储/循环/调度/UI）；Web UI；多运行时模式（标准 / Code(PTC) / Minimal / Creator） |
| 会话模型 | 追加式 **DAG**（JSONL，每条带 parentId）：`/tree` 分支跳转、fork | **线性**追加 JSONL：resume / compact / 崩溃修复，无分支 | 追加事件流 + Trajectory 视图：resume / fork / search / replay 共享同一事件流 |
| 后台任务 | 无（官方建议 tmux） | 有：后台子代理 + 完成推送（push 不轮询）；**无按 id 取消** | 有（平台级） |
| 多代理 | 核心无 | task 工具 + worktree 隔离 + resume_from | 平台级编排 |
| 参考成绩 | Terminal-Bench #2（4 工具） | — | 65.6k★ / 12k commits，开发者预览 |

定位结论：

- sph 的**架构哲学与 dsh 同源**（一切皆插件、core 只留接缝——服务清单甚至一一对应），但**规模与克制度更像 Pi**。
- Pi 证明了"少"能赢；dsh 证明了平台路线的代价是整个团队的持续投入。sph 是个人 runtime：**向 Pi 学克制，从 dsh 只借与单进程兼容的思想**（如事件流可回放），不追它的产品面。
- 原清单是"多实例 Agent 平台"的词汇表。逐项过完，真正缺且值得做的只有一件事：**后台任务按 id 取消**。其余要么已存在，要么在当前架构里没有承载位。

## 二、逐项判定

| 清单项 | 判定 | 依据 |
| --- | --- | --- |
| 实例创建 | ✅ 已有 | `task` spawn（`sph-subagent/tool.ts`）；主会话 `resumeOrCreate` |
| 实例销毁 | ⚠️ **改形做**：补"按 id 取消" | 见下文三.1。现状只有 `abortAll()`（`jobs.ts:157`），`JobRecord.status` 无 `cancelled` |
| 暂停 | ❌ 不做 | 见四 |
| 恢复 | ✅ 已有（会话级） | `--resume`/`-c`/`/resume`；子代理 `resume_from` 复制消息进新会话（`loop.ts:400-409`）——追加模型下比原实例续跑更干净 |
| 多实例并行 | ✅ 已有 | 进程级：同目录多 sph 各持一会话，锁防双写（`sph-session/lock.ts`）；进程内：前台 `Semaphore(SUBAGENT_CONCURRENCY)` + 后台 jobs |
| 隔离沙箱 | ❌ 不做（per-instance）；✅ 已有（进程级 + worktree） | 沙箱是**进程策略**不是实例特性；Windows ACL 能力 SID 按路径派生且机器级共享（README Known limitations），per-instance 授权要重造 ACL 模型。Pi 的答案同样是环境级隔离优于进程内隔离 |
| 上下文持久化 | ✅ 已有且完整 | 追加 JSONL、`closeInterruptedTurn`、fold 恢复 depth/goal/failures/planMode/tokensUsed、三层压缩、spill |
| 会话重置 | ✅ 已有 | `/new`；不带 `-c` 默认新会话。会话只列不删 |
| 无状态 / 有状态 Agent | ❌ 不做（概念不成立） | 见四 |
| 会话隔离防串扰 | ✅ 基本已有；⚠️ 一处瑕疵 | 子会话独立 JSONL、只见 prompt、父只拿最终报告、`activeSubagentSessions` 防重复续接、子事件封 `subagent_event`。**瑕疵**：`rootOnly` 只标在 `send_subagent_message`，`general` 子代理（tools: `*`）拿得到 `todo` 工具，而 TodoService 是同进程共享实例（`loop.ts` runChild 原样透传）——后台子代理与 root 共写一份清单，且 todo 事件分别落进各自会话文件，fold 回来可能互相覆盖 |

## 三、建议做（共两项）

### 1. `task` 取消（建议优先，真实痛点）

现状：主轮次可 ESC 中断（`app.interrupt`，排队消息退回输入框），但**后台子代理一旦启动就无法停止**——它有意与主轮次脱钩（`jobs.ts:54` 注释），主轮次中断不波及它，唯一停止方式是杀进程。跑飞的后台任务（死循环探索、写错方向）只能干等。

方案（小改动，半天到一天）：

1. `JobBoard`：per-job `AbortController` 替代共享 `taskController`；`abortAll` 逐个转发。
2. `JobRecord.status` 加 `cancelled`；`JobBoardPort` 加 `abort(id): 'cancelled' | 'not_found' | 'done'`。
3. `task` 工具 schema 的 `action` 枚举加 `cancel`（语义与 list/get 同级：只操作记录，不阻塞）。
4. TUI 后台任务行加取消键；通知正文区分 cancelled / failed。

注意边界：取消 = AbortSignal 触发，子代理在下一个 await 点退出，`finally` 里的 `subagent_end` / inbox 清理照常走（`loop.ts:540-568` 已保证成对落盘）；已完成的任务 cancel 返回 `done` 并提示用 resume_from。

实现记录（2026-09-24）：

- `JobRecord.status` 增加 `cancelled`；`JobBoardPort.abort(id)`；`JobBoard` 改 per-job `AbortController`（`abortAll` 逐个转发）；`drainNotifications` 把 cancelled 也算终态投递。
- `task` 工具 `action` 枚举增加 `cancel`；取消通知文案单列（CANCELLED），保留 `resume_from` 尾注——被取消子代理的部分成果仍在它的会话文件里。
- **TUI 后台行取消键延后**：dock 行（`subagent-task.ts`）是纯展示组件，没有选中/交互模型，加键需要先给 dock 建选中态。当前取消入口是 `task(action: cancel)`，用户对 agent 说一句即可触发。

### 2. todo 串扰收口（小，顺手）

实现记录（2026-09-24）：未用 `rootOnly`——`'*'` 展开走 `generalNames()`，rootOnly 会把 `/agent general` 坐席时的 todo 也剥掉，超出目标。改为沿用委托工具的既有剔除模式：`resolveChildTools` 对 `'*'` 子代理 `base.delete('todo')`，显式点名的自定义定义不受影响。

两个方向选一：

- **最小改**：`todo` 工具标 `rootOnly`——子代理不该维护跨会话清单（它们的产出物是最终报告）。
- **更干净**：TodoService 按 depth 作用域化，子代理有自己独立的清单（子代理也能自我跟踪步骤），互不可见。改动在 runChild 的服务装配处。

倾向第一种：与 roadmap"宁可少加"一致，且子代理自我跟踪的价值未证实。

## 四、明确不做

| 候选 | 不做的理由 |
| --- | --- |
| 运行时暂停（pause） | 无承载位：任务模型是"完成即推送"（push 不轮询，tool-roadmap 拒绝 sleep/wait 同源）；暂停引入状态机复杂度（暂停期间锁、沙箱、MCP 连接都要悬挂）。Pi 干脆没有后台任务；dsh 的暂停是平台编排特性。ESC 中断 + resume 已覆盖"停下来"的真实需求 |
| 运行时恢复原实例 | resume_from 已是恢复，且"复制进新会话"比"原实例复活"干净：无悬挂状态、无二次续跑的锁竞争。JSONL 追加模型下原实例续跑没有收益 |
| 实例级沙箱 | 沙箱柄按进程装配、ACL 能力 SID 机器级共享是**已知且声明过的设计**（Known limitations）；per-instance 意味着重造 Windows 授权模型，收益只覆盖"同时跑互不信任的子代理"这一不存在于个人 runtime 的场景。文件级隔离已有 worktree |
| 无状态 / 有状态 Agent 的形式化区分 | 能力面（tools + writes）× 运行形态（foreground = 拿报告即弃 / background = 可寻址、可续接、可取消）已经给出等价的用户可见区分。"无状态 = 不落盘会话"会 touch fold/repair/resume 全链路，换不来新行为。形式化的 API 区分是给平台用户的，sph 没有这类用户 |
| 多运行时模式（Code/Minimal/Creator）、PTC | dsh 的平台特性，背后是 Web UI + SDK + 插件试验场。sph 的工具面已按 TOOL_SECTIONS 预算管理，"少"本身就是路线 |
| Web UI | TUI-first 是产品身份（自研 widget 层）；headless `--output-format json` 已是脚本集成面 |
| 后台 shell（Pi 同款缺口） | roadmap 已定：长任务走 task，不加后台 shell |

## 五、缓做（观察单，等真实需求）

- **会话 DAG / 分叉（`/tree`）**：Pi 与 dsh 都有，价值真实（从某一步重试）。但 sph 会话是线性 JSONL，改 DAG 动存储格式与 fold/repair/resume 三条链路。先等"想从半截重来"的诉求实际出现。
- **Trajectory 级注入审计**：dsh 把"每一次上下文注入"按来源落盘可查。sph 的 compaction / steering / 附件注入已有事件，补齐成本低，但个人工具场景下排查价值有限。观察到出现"这段话是谁塞进来的"排查需求再说。

## 六、落地顺序

1. **`task` 取消**（三.1）——唯一的功能缺口，收益直接。
2. **todo rootOnly**（三.2）——一行标志 + 测试。
3. 其余维持现状；观察单两项不排期。

合计约一天。
