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

`sph` alone gives you a conversation you can steer. The interface is
**full-screen**: it switches to the terminal's alternate screen buffer (the same
mechanism vim and htop use), so you get a clean, empty screen instead of a wall
of your shell's previous output — and when you quit, the terminal is restored
exactly as it was. Nothing from the session is left behind in your scrollback.

One consequence of giving up the terminal's own screen: **the terminal's
scrollbar and scrollback can no longer move the conversation.** Nothing outside
the app can shift the view — not the scrollbar, not `Shift+PgUp`, not the wheel
on its own. Scrolling is handled inside the app instead; see the keys below.

Each frame is painted as a whole. The screen is divided into **four fixed regions**,
stacked top to bottom like block boxes in HTML:

| # | Region | Height | Contents |
| :-- | :--- | :--- | :--- |
| 1 | Title bar | fixed 1 row | `SPRING HARNESS v<version>` on the left, project and branch on the right |
| 2 | Conversation | all remaining rows | the scrollable user/model dialogue (banner, turns, tool blocks) |
| 3 | Input | fixed 3 rows | background band, no border, `>` vertically centred on the middle row |
| 4 | Status bar | fixed 1 row | the `📁 | 🌿 | 🤖 | 🧠 | 🧮 | 🔁 | 🔒` segments |

Only region 2 changes size: regions 1, 3 and 4 keep their exact position and
height at every window size, and the conversation viewport simply grows or
shrinks between them. Region 2 is bottom-aligned, so the newest line always sits
directly above the input area and the empty space (when history is short) is at
the *top*. The version in region 1 is read from `package.json` at startup — one
source of truth, never hand-copied.

When the terminal is too short for the full stack the regions degrade in a fixed
priority order — conversation first, then title bar, then input, and the status
bar last (a single-row terminal still shows the status bar):

```
|SPRING HARNESS v0.1.0                              spring-harness | 分支 main
|                                                                          <- blank
|这是最新的助手回复，贴着输入区上沿。                                      <- region 2: conversation
|                                                                          <- region 3, row 1
|> 重构 compact.ts 的估算是怎么做的                                        <- region 3, row 2 (centred)
|                                                                          <- region 3, row 3
|📁 spring-harness | 🌿 main | 🤖 gpt-x | 🧠 medium | 🧮 [#---] 24% | 🔁 85% | 🔒 ask
```

Because every frame rewrites the entire screen, a terminal resize cannot leave
the stale copies behind that a patch-based redrawer would.

Keys:

- `Enter` — send. A line starting with `/` is a command instead.
- `/` or `Ctrl+K` — command menu; Up/Down pick, `Enter` run, `Esc` cancel.
  Typing filters it (`Ctrl+K` opens the full list, `/` opens it already prefixed).
- Commands that take a value drill down instead of running: `Enter` on `/approval`
  opens a second-level list (`ask` / `auto` / `yolo`) with the current value marked
  `（当前）` and pre-selected; `Enter` applies it, `Esc` or `Backspace` on an empty
  filter goes back to the command list, a second `Esc` closes. Same for `/effort`,
  `/export` and the `/sessions` · `/switch` session picker. Typical flow:
  `/` → `approval` → `Enter` → Down → `Enter`.
  Typing the value directly (`/approval yolo`) still works and skips the list.
- Up / Down — prompt history (when the input is empty).
- **Scrolling the conversation.** Because the app owns the screen (above), the
  terminal itself cannot move the view. Two things can:
  - the **mouse wheel** — 3 lines per notch;
  - **`PgUp` / `PgDn`** — one page at a time, keeping one line of overlap.

  `Esc` returns to the latest (a first `Esc` while scrolled only goes back to
  the bottom — a second one aborts the running turn), and typing anything jumps
  back to the latest too.
- **Selecting text.** Mouse reporting is on, which means the *terminal* no longer
  does drag-to-select — the app owns the mouse. Selecting is therefore implemented
  in the app: **drag with the left button and release, and the selection is already
  on your clipboard** (copy-on-select, no `Ctrl+C` needed — `Ctrl+C` stays
  "abort the turn"). Copying goes out as OSC 52 first, then falls back to the
  platform command (`clip` on Windows, `pbcopy` on macOS, `wl-copy`/`xclip` on
  Linux); a notice says which one worked. Set `SPH_CLIPBOARD=osc52` to skip the
  subprocess, or `off` to stop writing the clipboard entirely.

  This is the same tradeoff opencode makes. If you would rather have the
  terminal's own selection, set `SPH_MOUSE=0` (also `false`, `off`, `no`) to turn
  mouse reporting off — native drag-select comes back, the wheel stops working,
  and `PgUp`/`PgDn` still do. In Windows Terminal you can also hold `Shift` while
  dragging for a native selection even with reporting on.
- **The wheel only scrolls the conversation region.** Wheel events over the title
  bar, the input area or the status bar are ignored — those regions have nothing
  to scroll, and swallowing the wheel there only makes it feel like the view
  jumped somewhere else.
- `Ctrl+A/E/K/U/W`, `Ctrl+B/F` — line editing as in readline.
- `Ctrl+L` — clear the conversation view. The session itself is untouched
  (`/export` still gets the whole thing).
- **`Ctrl+C` — abort the running turn; press it twice to exit.** A single `Ctrl+C`
  aborts the running turn (or, when idle, clears the input) and shows
  `再按一次 Ctrl+C 退出`; a second press within one second quits. Exiting is
  therefore never one keystroke away from "just stop this step" — the terminal
  convention that `Ctrl+C` means *interrupt* is preserved. `Ctrl+D` on an empty
  input is the one-key exit.
- `Esc` — abort the running turn, close an overlay, or clear the input.

Commands: `/help` `/new` `/sessions` (pick from a menu of past sessions)
`/switch <id>` `/status` `/plan` `/model` `/effort <level>`
`/approval <mode>` `/todo` `/jobs` `/export [md|json]` `/clear` `/quit`.

`/model` fetches the upstream model list from the configured `base_url` with the
configured API key, then guides you through model selection, context window,
maximum output tokens, and a final confirmation. Model IDs cannot be typed into
this command directly.

Persistence: `/model`, `/effort` and `/approval` write your choice back to
`~/.sph/config.toml`, so it survives a restart — the notice says which file was
written, or why it could not be. Precedence is command line > config file >
built-in default (`--model`, `--effort`, `--approval` still win for that run).
The writer edits the file surgically rather than re-serialising it: an existing
key keeps its trailing comment, a commented-out template line such as
`# reasoning_effort = "medium"   # off | low | ...` is activated **in place** (the
hint stays), and an unknown key is appended. Comments, key order and unrelated
keys are never touched.

`/plan` is deliberately *not* persisted: plan mode is a per-task decision, and
remembering it across restarts would silently reduce the tools available on the
next launch.

`/status` opens a panel with the session id, workspace, sandbox, MCP servers
and tools, token usage against `context_window`, todo progress and background
jobs. Token counters accumulate every model call of the session.

In the TUI, `ask` mode asks you instead of denying, `ask_user` reaches you, and
`exit_plan_mode` gets a real approval — plan mode actually works. In `auto`
mode a verdict of the reviewer that denies (or the reviewer being unavailable)
escalates to you rather than failing closed silently.

Visual conventions:

- Every line is measured with CJK-aware width and wrapped by us, and skeleton
  glyphs are ASCII only: middle dots, ellipses, arrows and box-drawing characters
  are East-Asian-ambiguous width and render as 2 cells in some terminals, which
  would wrap a line and shift the whole frame up by one row. As a last line of
  defence the painter clips each row to the terminal width before writing it.
- Colors are 16-color SGR on purpose — they resolve through the terminal's own
  palette, so a light and a dark theme both stay readable, with no hardcoded
  brightness. Semantic mapping: cyan = your input and interactive focus,
  yellow = needs your decision (all three prompts share it), magenta = plan mode
  only, green/red = success/failure, `dim` = metadata only (durations, counts,
  folded bodies, hints), inverse = the selected menu row. Body text — replies and
  tool output — keeps the default foreground.
- Assistant replies are rendered as **Markdown**; your own input is not. Supported:
  headings (levels distinguished by bold, `h1` also underlined — no extra colour is
  spent on hierarchy, so it still works in a monochrome terminal), paragraphs,
  ordered / unordered / task lists with nesting, fenced code blocks (language label,
  content clipped rather than wrapped so it stays copyable, with syntax highlighting
  for TypeScript/JavaScript, JSON, Python, shell and diff — an unknown language
  renders as plain text rather than guessing), blockquotes, horizontal
  rules, tables (`|` grid with `:---:` alignment) and inline **bold** / *italic* /
  ~~strike~~ / `code` / [links](https://example.com). A link's target is not printed
  inline; `/status` and `/export` keep the raw text.
  Not supported, and shown as literal syntax rather than guessed: inline HTML,
  reference-style link definitions, setext headings, indented code blocks. A single
  newline is a hard break (models emit line-oriented output — ASCII diagrams,
  unmarked lists — far too often to re-flow it).
- Your input stays literal except that `@mentions` are highlighted; rewriting a
  user's `*` into emphasis or their `#` into a heading makes them think their input
  was altered.
- Syntax highlighting is a hand-written stateful line scanner, not tree-sitter:
  multi-line comments and template/triple-quoted strings carry state across lines,
  and the state belongs to one code block so it cannot leak into the next. Colouring
  only inserts SGR — it never adds or removes a visible character, so the width
  invariant is unaffected.
- Tool calls belonging to one model step are collected and printed as a single
  block once that step ends, with a header (`3 个工具调用 | 1 个失败 | 1.2s`).
  While they run, the live indicator in the status line shows the tool and its
  elapsed time (`shell 1.4s`).
- Summaries are per tool: `read_file src/a.ts:1-40 (40 行)`, `grep "foo" -> 7 处`,
  `write src/a.ts +12`, `search_replace src/a.ts -2/+1 x3`,
  `shell $ npm test -> exit 0`. Long output folds to 8 lines for a lone call, to
  2 lines per call inside a multi-call block (6 for failures).
- The status line is `| <icon> value | ... |`, in this order: project directory,
  git branch, model, reasoning effort, context usage, prompt-cache hit rate and
  permission mode. Icons: 📁 project, 🌿 branch, 🤖 model, 🧠 effort, 🧮 context,
  🔁 cache, 🔒 ask / 🔐 auto / 🔓 yolo. A field whose data is unavailable is
  omitted entirely — no branch outside a git repository, no cache row when the
  endpoint never reports cached tokens (which is not the same as 0% hits).
  While a turn runs, the tool being executed is prefixed as `grep 1.4s`.
  `PLAN` and `沙箱 off` are appended when relevant — they change what tools may
  run, so they are never dropped for width.
- On narrow terminals the status line sheds its least important fields instead of
  truncating them; project, model and permission mode survive longest (permission
  mode is pinned, since it decides whether tools run without asking you).
  `/status` always shows every field, including the workspace path and sandbox.
- Notices are levelled: info/success fade after a few seconds, warn/error stay
  until your next action.

Notes:

- The TUI holds the workspace session lock for as long as it runs, so a second
  `sph` in the same workspace exits with `session already in use by pid ...`.
- Colors are dropped when `NO_COLOR` is set or the output is not a TTY.
- Mouse support is limited to the **wheel**, and only for scrolling the
  conversation view. There is no click, drag, in-app selection or context menu.
- The wheel needs SGR mouse reporting (`?1006h`). Terminals that speak only the
  old X10 format send wheel events in a shape the app deliberately discards — so
  they can never leak into the input line, but the wheel is inert there and
  `PgUp`/`PgDn` are the only way to scroll.
- Windows Terminal is the primary target; the same ANSI path keeps it usable on
  Linux and macOS terminals. Legacy cmd.exe (conhost) needs Windows 10 1607+ for
  the alternate screen buffer; without it the sequences are ignored and the UI
  degrades to painting over the current screen.
- Resizing needs no repair work: every frame rewrites the whole screen from the
  top-left, so whatever the terminal reflowed is overwritten by the next frame
  instead of accumulating. Repaints are throttled (one immediately, then at most
  one per 50 ms) purely so that a window drag does not turn into a redraw storm.
  Frames are painted one column narrower than reported (`columns - 1`) because
  some conhost builds report a usable width one column too wide.
- Painting is wrapped in the `?2026` synchronized-output sequence so a frame is
  committed atomically and does not visibly tear; terminals that do not know the
  sequence ignore it.



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
