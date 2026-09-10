# Usage

## Config

Write `%USERPROFILE%\.sph\config.toml`:



```toml
base_url = "https://api.example.com/v1"
model = "example-model"
context_window = 256000
# max_tokens = 8192          # 单次输出上限（正整数，可选）
sandbox = "workspace"
```



Set `SPH_API_KEY` or put `api_key` in the file. The environment variable wins.
Keys are never written to logs or session JSONL.



`--model <name>` overrides the configured model for one process;
`--max-tokens <n>` overrides `max_tokens` the same way.



## Upstream protocol

`api` in `config.toml` (or `--api <protocol>` for one process) selects how sph
talks to the endpoint:

- `chat-completions` (default) — OpenAI `/v1/chat/completions`, Bearer auth.

  Works with every OpenAI-compatible endpoint and relay.
- `responses` — OpenAI `/v1/responses`, tool specs flattened, reasoning effort
  sent as `reasoning.effort`.
- `anthropic-messages` — Anthropic `/v1/messages`, `x-api-key` +
  `anthropic-version` headers (Bearer sent too, for gateways that prefer it)。
  `reasoning_effort` maps to a `thinking` budget; `max_tokens` defaults to 8192
  and is raised above the budget automatically.



All three share the same tool-calling, streaming, retry and usage semantics —
pick per model,e.g. a relay exposing one model over both protocols.



`max_tokens` in `config.toml` caps a single completion: `max_tokens` on
chat-completions, `max_output_tokens` on responses,and the `max_tokens`
override on anthropic-messages。Unset, the field is not sent from
chat-completions/responses (the endpoint's cap applies) and remains 8192 on
anthropic-messages.



## Reasoning effort

Set the model's reasoning effort via `reasoning_effort` in `config.toml` or
`--effort <level>` for one process. Levels: `off | low | medium | high | xhigh |
max`.



- `off` sends no `reasoning_effort` field at all — sph stays out of the way and
  the endpoint's default applies; this is also the state when the setting is
  unset.
- Other levels are passed through as the protocol's `reasoning_effort` value
  (`reasoning.effort` on the Responses API, a `thinking` budget on
  Anthropic Messages)。`xhigh`/`max` are non-standard for many upstreams —
  endpoints that do not recognize them will return an error; pick a lower
  level then.



## Commands

`sph` with no `-p` opens the interactive TUI — one long-lived process, many
turns, approvals answered by you. With `-p` it is still exactly one headless
turn, unchanged. Non-TTY stdin/stdout (a pipe or CI) never enters the TUI: it
exits with the usage error instead of hanging on a keypress.



```
sph                          Interactive TUI (needs a terminal)
sph -p "<prompt>"            One headless turn, then exit
sph -p "..." --output json         Single JSON result object (text, usage, schemaValid)
sph -p "..." --output stream-json  NDJSON agent events, one per line
sph -p "..." --schema s.json        Ask the model for JSON matching the schema file
sph -c -p "..."               New session
sph --resume <id> -p "..."   Resume a specific session (see: sph sessions)
sph --fork -p "..."        Fork current JSONL into a new session id
sph sessions [--search kw]         List (or keyword-filter) sessions
sph export [--format md|json] [--session id]   Export a session to stdout
sph --model <model>       Override the configured model for this process
sph --max-tokens <n>      Max output tokens per completion (overrides config)
sph --effort <level>      Reasoning effort
sph --api <protocol>      Upstream protocol: chat-completions | responses | anthropic-messages
sph --approval MODE       ask | auto | yolo (default: ask; LLM reviews in auto)
sph --yolo                Auto-approve shell / web_fetch / mcp (does not raise sandbox to off)
sph --trust               Remember this workspace as trusted (required for untrusted workspaces)
sph --sandbox MODE        off | workspace | read-only
```



Exit codes: `0` ok, `1` runtime error, `2` usage/config, `3` `--schema` output
was not parseable JSON.



`shell` / `web_fetch` / `mcp` is denied without `--yolo` in headless. An
untrusted workspace refuses `-p` without `--trust`; the TUI asks once
interactively instead. `--schema` and `--output json|stream-json` require `-p`.

## Interactive TUI

`sph` alone gives you a conversation you can steer. The transcript goes into
the terminal's own scrollback (so native scroll, search and copy all work);
only a small live region at the bottom is redrawn — the overlays, the input
line and the status line.

```
> 重构 compact.ts 的估算是怎么做的
                    ← 正文与工具结果追加在滚动区，工具输出折叠成前 8 行
  gpt-x · 审批 ask · 沙箱 workspace · ↑12.3k ↓1.1k · todo 2/5 · jobs 1
```

Keys:

- `Enter` — send. A line starting with `/` is a command instead.
- `/` or `Ctrl+K` — command menu; `↑↓` pick, `Enter` run, `Esc` cancel. Typing
  filters it (`Ctrl+K` opens the full list, `/` opens it already prefixed).
- `↑` / `↓` — prompt history (when the input is empty).
- `Ctrl+A/E/K/U/W`, `Ctrl+B/F` — line editing as in readline.
- `Ctrl+L` — clear screen. `Ctrl+C` — abort the running turn; exit when idle.
- `Esc` — abort the running turn, close an overlay, or clear the input.

Commands: `/help` `/new` `/sessions` (pick from a menu of past sessions)
`/switch <id>` `/status` `/plan` `/model [name]` `/effort <level>`
`/approval <mode>` `/todo` `/jobs` `/export [md|json]` `/clear` `/quit`.

`/status` opens a panel with the session id, workspace, sandbox, MCP servers
and tools, token usage against `context_window`, todo progress and background
jobs. Token counters accumulate every model call of the session.

In the TUI, `ask` mode asks you instead of denying, `ask_user` reaches you, and
`exit_plan_mode` gets a real approval — plan mode actually works. In `auto`
mode a verdict of the reviewer that denies (or the reviewer being unavailable)
escalates to you rather than failing closed silently.

Notes:

- The TUI holds the workspace session lock for as long as it runs, so a second
  `sph` in the same workspace exits with `session already in use by pid ...`.
- Colors are dropped when `NO_COLOR` is set or the output is not a TTY. There
  is no mouse support and no emoji.
- Windows Terminal is the primary target; the same ANSI path keeps it usable on
  Linux and macOS terminals. Resizing the terminal may occasionally leave one
  stale line above the live region.



## Resilience

LLM requests retry on `408/429/5xx` and network errors with exponential
backoff plus jitter ( 3 attempts, honoring `Retry-After`). Once a turn has
streamed visible text, a broken stream fails the turn instead of retrying, so
output is never duplicated。Every model call records a `usage` event in the
session JSONL; `--output json` reports accumulated tokens.



## Context compaction

Above 80% of `context_window`, compaction runs in two stages: old tool
results are stubbed (free), then older turns are summarized by the LLM into a
durable `[compacted earlier context]` block。Summaries are stored as
`compaction` events and reused, so a long session only pays for the *new*
part of the history each time. If the summarizer call fails, compaction falls
back to a zero-cost mechanical projection.



## Images

- `read_file` on `png/jpg/jpeg/gif/webp` (≤8MB）attaches the image to the
  model context.



## Subagents

`subagent` supports `background: true` (returns a job id pollable via
`jobs(action:"get")`) anda short `description` for the jobs list. Up to 4
subagents run in parallel; extra requests queue. Nesting(a subagent spawning
a subagent) is denied.



## Instructions (memory)

Loaded into the system prompt, in order: `~/.sph/AGENTS.md` (user-global),
then workspace root `AGENTS.md` falling back to `CLAUDE.md`. `AGENTS.md`
files in nested directories are injected on touch: when a tool reads or
writes inside that directory, its instructions enter the context once per
session.



## Sessions

Sessions are JSONL, one per conversation, under `~/.sph/sessions/<workspace>/`.
`sph sessions` lists them with a preview; `--search` greps message bodies;
`sph export` renders Markdown (tool output collapsed) or raw JSON.



Optional stdio MCP servers in `config.toml`:



```toml
[[mcp_servers]]
name = "demo"
command = "npx"
args = ["-y", "demo-mcp"]
```



stdio servers that crash are re-spawned lazily on the next call, and
`tools/list_changed` notifications refresh the tool catalog mid-session.



## Workspace trust

Pass `--trust` to record the workspace root in `~/.sph/trusted.json`. A
trusted ancestor covers nested directories. `-p` on an untrusted workspace
refuses with exit 2。`--yolo` does not imply `--trust`. `sph sessions` and
`sph export` skip the check (no agent, no workspace instructions).



## Approval modes

Three approval modes govern `shell`, `web_fetch` and `mcp` (file tools are
governed by the sandbox, not approvals):

- **ask** (default) — headless denies the reviewed tool; the TUI asks you.

- **auto** — an LLM safety reviewer judges each reviewed call (allow/deny with
  a reason. Reads, builds, tests and ordinary dev commands pass; destructive
  or exfiltration-shaped calls are denied and the model sees the reason.


  The reviewer runs on the same model; if it fails or is ambiguous the call is
  **denied** (fail-closed。Escalations, `ask_user` and plan approval always
  reach a human regardless of mode.

- **yolo** — everything auto-approved; `--yolo` is its CLI shortcut.



Select with `--approval ask|auto|yolo` (`--yolo` jumps straight to yolo).
In headless there is no human at the terminal: `ask` denies reviewed tools and
`auto` leans fully on the reviewer. In the TUI both reach you — `auto` escalates
a denying or unavailable reviewer to a human prompt instead of failing closed
silently (it never silently *allows*).



## Sandbox

Default is `workspace`. Enforcement is **partial**.



- Windows: restricted token + ACL (reads / network / hard links not confined)
- Linux: bwrap bind mounts (requires `bwrap`; fail-closed)
- macOS: unsupported — pass `--sandbox off`



`read-only` denies `write` and `search_replace`. `--yolo` never promotes the
sandbox to `off`.



When sandbox is on, `shell persistent=true` still runs one confined process per call
(no unsandboxed long-lived shell。Long-lived stdin reuse exists only for `--sandbox off`.