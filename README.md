# Spring Harness (`sph`)

A general-purpose agent runtime that runs on your own machine: one process, a terminal UI, and a tool-using LLM loop over a single workspace. Programming, research, writing, and organizing materials are all in scope.

It is written from scratch in TypeScript with six runtime dependencies — no CLI framework, no third-party TUI toolkit, no HTTP client wrapper. The terminal widgets live in `src/tui` and are only used by `sph-tui`. The widget layer does not import the agent loop, sessions, or tools.

- **Agent loop** — multi-step tool calling with parallel-safe tool batching and results committed in model order. `max_turns` is optional; when set, a subagent winds down and returns what it already found instead of discarding the turn.
- **Context management** — three-tier compaction (tool-result stubbing → LLM incremental summary → mechanical fold) plus recovery when a provider rejects the request as over-window.
- **Subagents** — the `task` tool spawns them (foreground fan-out of 3, or background with completion push) and lists background records. `resume_from` and optional `git worktree` isolation. Flat tree by default.
- **Sessions** — append-only JSONL per workspace; state (todos, goal, plan mode, token spend) is folded back on resume.
- **Sandbox** — off unless you turn it on. `workspace` and `read-only` are a same-host file policy: Linux `bwrap` (Landlock if `bwrap` is missing), macOS Seatbelt, Windows restricted token + ACL. Reads and network stay on the host. Windows enforcement is partial.
- **Three upstream protocols** — `chat-completions`, `responses`, `anthropic-messages`, with runtime parameter degradation so an endpoint that rejects `max_tokens` or `stream_options` is adapted to instead of failing.
- **Plugins** — built-ins live in `src/plugins/`, third-party ones in `.sph/plugins/`. They register tools and provide services, and the core never imports them. `sph-mcp` ships as one, so MCP is an optional capability rather than a built-in. See [Plugins](#plugins).
- **MCP** — provided by the bundled `sph-mcp` plugin: stdio, streamable HTTP, and legacy SSE, discovered from five config sources, with lazy reconnect and hot reload. A `url` is HTTP unless `transport = "sse"` or the path ends in `/sse`. On Windows, bare commands (`npx`…) are resolved via `PATH × PATHEXT`; `.cmd`/`.bat` launchers run through `cmd.exe` with cmd-safe escaping (a bare `npx` is not an `.exe`, so naive spawning fails with ENOENT).
- **Skills** — `SKILL.md` catalogs discovered from four roots.

## Provenance

sph is an independent, from-scratch implementation — no code, prompts, or documentation from other agent projects is included, and none is derived from them. It shares its shape with Pi, Claude Code, and Codex CLI because that shape is what a terminal coding agent converges on: a read/edit/bash-style core toolset, append-only JSONL sessions, a streaming tool-calling loop, and an interactive/one-shot/JSON/RPC mode split. Where it diverges, the divergence is deliberate: every capability behind a typed plugin seam (model, session, loop, tools, MCP, todo, plan, sandbox, subagent, scheduler, UI), approvals and a same-host sandbox as first-class layers rather than afterthoughts, subagents with worktree isolation, three hand-written protocol adapters covering any OpenAI-compatible endpoint instead of per-vendor adapters, and a compact codebase (≈40k lines, comments in Chinese recording the *why* behind every constraint) meant to be read end-to-end by one person.

## Requirements

- Node.js **>= 22**. Bundled plugins are compiled with sph, so only **third-party** `.ts` plugins need **>= 22.18** (>= 23.6 on the 23 line) — that is when Node's native type stripping became the default. Ship a third-party plugin as `.js`/`.mjs` to support older Node.
- Windows, Linux, or macOS. The process starts with the sandbox off. Turning it on uses the host's own file policy and refuses to start that mode if the runner is missing.

## Install

```bash
npm install          # also builds (prepare hook)
npm run build        # tsc -> dist/
npm link             # optional: puts `sph` on PATH
```

## Configure

`sph` reads two user files, both hand-written: `~/.sph/config.toml` (which endpoint to use, how to behave) and `~/.sph/models.json` (what the endpoints and models are). Running without a valid pair prints a full template and exits with code 2.

A minimal `models.json`:

```json
{
  "providers": {
    "example": {
      "baseUrl": "https://api.example.com/v1",
      "api": "chat-completions",
      "apiKey": "$EXAMPLE_API_KEY",
      "models": [
        { "id": "example-model", "name": "Example Model", "contextWindow": 256000 }
      ]
    }
  }
}
```

A minimal `config.toml`:

```toml
provider = "example"           # points at a provider in models.json
model = "example-model"
context_window = 256000        # fallback when the model declaration has no contextWindow
sandbox = "off"               # workspace | read-only turn on same-host file confinement
```

Key facts:

- Endpoints live in `models.json`, not in `config.toml`: `baseUrl`, `api` (`chat-completions` | `responses` | `anthropic-messages`, set per provider and overridable per model), `apiKey`, `headers`, and `compat`. `apiKey` and header values support `$VAR` / `${VAR}` interpolation; an explicitly empty `apiKey` means *send no auth header* (pair it with provider `headers` so keyless gateways can identify the session). There is no global `SPH_API_KEY` any more — each provider carries its own key reference.
- Per-model declarations supply `name`, `contextWindow`, and `maxTokens`; `config.toml`'s `context_window` / `max_tokens` are fallbacks for undeclared models. `--model` is the model id exactly as written (slashes included). Switch provider with `--provider`. `/model` lists every declared model across providers and writes the selection back to `config.toml`.
- `provider` (config.toml) selects the endpoint; `[aux] provider` (optional) routes the summariser and `auto`-approval reviewer at another declared provider — that is what makes a cross-vendor cheap summariser possible. `compact_model` / `review_model` are model ids resolved against that provider.
- `compat` is declared per provider (defaults for its models) and merged per model. Declared bits override URL inference; `prompt_cache = false` in config.toml vetoes cache-related bits.
- `prompt_cache` (default `true`) places Anthropic prompt-cache breakpoints and sends `prompt_cache_key` on OpenAI-style protocols. `prompt_cache_retention` stays off unless `compat` turns it on. The protocol picks the first field names; if the endpoint names another (`max_tokens` / `max_completion_tokens` / `max_output_tokens`, and the same for reasoning), the next try uses that name. Rejected optional fields are dropped, logged as `compat_retry` in the session file, and shown on the working-status line with a count. Headers in `models.json` are sent as written. The system prompt is frozen within a turn and the mechanical-stub boundary is pinned once it first engages, so the request prefix stays byte-stable; whole-prompt cache misses are logged as `cache_miss` events in the session file rather than shown in the UI.
- `max_session_tokens` (default `0` = unlimited) caps cumulative prompt+completion tokens for the whole agent tree, including subagents and compaction. The count survives `--resume`; the turn stops before the next request when the budget is gone, and warns at 80%.
- `max_retries` (default `10`) is how many times a failed upstream request is retried, not counting the first attempt. `0` fails immediately. Only 408/429/5xx, network errors, idle timeouts, and empty responses retry.
- `subagent_max_depth` (default `1`) — `0` forbids delegation entirely.
- `max_turns` (unset by default) — a positive integer cap on model calls in one subagent turn. Omit it and a subagent still stops after 20 calls: it is told to write up with a few steps left, then its last report comes back as a failed tool result marked with the step limit and a `resume_from` session id. A configured value replaces that 20. The root session is not capped by this key. A configured `max_session_tokens` is also enforced inside the running subagent, against the budget still left, not only on the parent's next step.
- `subagent_approval` (default `inherit`) — `strict` makes subagents fail closed: reviewed tools are denied without prompting, and the parent session's grants are not shared. `inherit` hands the child the same approver, grants included.
- `[permissions]` — `allow` / `ask` / `deny` lists of `Tool` or `Tool(specifier)` entries, evaluated `deny` → `ask` → `allow` **across layers** (any layer's `deny` outranks every `allow`; both outrank the mode, including `yolo`; in headless an `ask` rule is a denial — nobody to ask). Specifier is interpreted per tool:
  - `bash(git log *)` / `bash(npm test:*)` — command prefix glob; `*` spans anything, a trailing ` *` also matches the bare command; `timeout` / `nice` / `nohup` / `KEY=value` prefixes are stripped first; `bash(background=true)` matches parameters
  - `read(~/secrets/**)` / `edit(/src/**)` — gitignore-style paths (`//` absolute, `~/` home, `/` relative to the file declaring the rule, bare relative to the workspace; `!` negates, last match wins); relative patterns in `deny`/`ask` apply at any depth, `allow` anchors to the workspace
  - `web_fetch(domain:example.com)`, `mcp(context7)` or `mcp(context7.tool)`
  - a bare tool name (`Bash`) or a tool-name glob (`mcp*`) in `deny` removes the tool from the model's context entirely
- Rules layer: user-level `[permissions]` in `~/.sph/config.toml` plus project-level `<repo>/.sph/config.toml`, which may set `[permissions]` and `[mcp_servers]` only; a project's `allow` rules are ignored until you trust the workspace (`deny`/`ask` always apply). Read-only shell commands (`ls`, `git status`, …) never prompt in any mode — gate them with `ask`/`deny` if you need to.
- Approvals ("always allow") are recorded in `<repo>/.sph/permissions.json` (git-ignored automatically on first write), keyed by exact action; the dialog also offers "always allow rules like this", which promotes the suggested prefix rule into the project's `[permissions].allow`. The legacy `[grants]` table in config.toml is no longer read.
- `sandbox_auto_allow` (default `false`) — when the sandbox is not `off`, shell commands stop prompting entirely. Opt in only after reading the sandbox notes below: this fence is same-host and partially enforced on Windows, not a process isolation boundary like Codex's.
- `[ui] notify` (default `auto`) — how the TUI tells you work finished: `auto` (bell plus a desktop notification when the terminal accepts one) | `bell` | `desktop` | `off`. `[ui] notify_after_seconds` (default `10`) is the gate while the terminal still has focus — shorter waits stay silent; `0` reminds on every completion, and an unfocused terminal always reminds. Headless (`sph -p`) has nobody waiting, so it reads nothing.

## Usage

```bash
sph                                  # interactive TUI (needs a real terminal)
sph -p "explain the auth flow"       # one headless turn, then exit
sph -p "..." --output-format json    # NDJSON events on stdout, one per line
sph sessions                         # list main sessions of this workspace
sph sessions --search kw             # filter, with hit counts
sph export --format md               # dump a session to stdout
sph --resume <id>                    # reopen a specific session
sph -c                               # continue the most recent one
```

Useful flags: `--model`, `--effort` (`off|low|medium|high|xhigh|max`), `--max-tokens`, `--api`, `--approval ask|auto|yolo`, `--sandbox off|workspace|read-only`, `--trust`, `sph rules check "<command>"` (preview how the rules judge a command).

Theming: sph ships a fixed dark palette. Set `SPH_THEME=terminal` to drop hardcoded colors and emit basic ANSI codes instead, so the TUI follows your terminal emulator's own 16-color theme (canvas becomes the terminal's default background).

TUI commands: `/help` `/history` `/new` `/resume` `/skills` `/plugins` `/mcps` `/plan` `/goal` `/compact` `/model` `/provider` `/effort` `/permission` `/export` `/diff` `/copy` `/fork`. `/resume <id>` switches straight to a session and bare `/resume` opens the picker; `/sessions` is an alias. `/compact [instructions]` folds older history into a checkpoint on demand, optionally steering what the summary emphasises. `/provider` switches provider in two steps: pick a provider, its upstream catalog is fetched, then pick a model — a model not yet declared in `models.json` is appended there before switching (a fetch failure degrades to the declared list). `/permission` sets the approval mode (`ask | auto | yolo`) and writes it back to `config.toml` as the `approval` key. `/skills` re-scans the skill roots on every open, and `/mcps` reports live server status and lets you enable/disable, add, remove, and reload — all reflect the current state rather than what the running turn started with.

Selecting text: drag to select (character grain), double-click for a word — paths and kebab-case tokens stay whole — triple-click for a line; dragging to the top or bottom edge scrolls and extends. The selection lives on source lines inside scroll views, so scrolling away does not drop it. Copy it with a right-click, `Ctrl+Shift+C` / `Alt+C`, or `/copy`; sph tries the platform clipboard tool first and falls back to an OSC 52 write, saying in the status line which route it took. Where the terminal claims that chord itself and the fallback is rejected, use the emulator's own selection (`Shift`+drag in most of them).

Lists (menus, pickers, report rows) activate on double-click or Enter; a single click only moves the highlight. Folding rows (tool calls, report groups) toggle on double-click, and `Ctrl+O` toggles every tool group at once.

Completion notices: `[ui] notify` (`auto | bell | desktop | off`, default `auto`) decides how sph tells you work finished — a turn ending, a background task or subagent delivering its result, `/compact` finishing. `auto` rings the terminal bell and, if the terminal accepts one of the desktop-notification OSCs (9 / 777 / 99, detected from the usual environment variables), posts a notification titled `sph`. The gate is focus-aware: lose focus and every completion reminds you; keep it and sph stays silent until the wait reaches `notify_after_seconds` (default `10`, `0` = always remind). A turn you interrupted yourself never reminds.

### Plugins

A plugin is a module that extends sph. It exports a factory (or an object with `setup` and an optional `description`), receives a `PluginApi`, and can **register tools** callable by the model and **provide services** other plugins and the UI can consume:

```js
// ~/.sph/plugins/git-guard.js
export default function setup(api) {
  api.registerTool({
    name: 'git_guard',
    description: 'Report whether the worktree is dirty before a command runs.',
    schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async execute(args) {
      return { ok: true, content: api.clip(`checked ${String(args.command)}`) };
    },
  });
  api.warn('git-guard is in dry-run mode');
}
```

`.ts` works the same way (with the constraints below). sph does not publish `.d.ts` yet, so a TypeScript plugin either declares the shapes it uses inline or imports types from a checkout of this repo — the JS example above is the path of least resistance.

Plugins are discovered from three roots. On a name clash the higher one wins as a whole:

| Root | Scope | Form |
|---|---|---|
| `src/plugins/*` | Bundled with sph. The product is these plugins: `sph-llm`, `sph-tools`, `sph-skills`, `sph-session`, `sph-storage`, `sph-loop`, `sph-schedule`, `sph-tui`, plus `sph-mcp`, `sph-todo`, `sph-plan`, `sph-sandbox`, `sph-subagent` | Directory with `index.ts` |
| `~/.sph/plugins/*` | Your own, every project | Directory or single file |
| `<workspace>/.sph/plugins/*` | Project-local — **loaded only when the workspace is trusted** | Directory or single file |

Third-party plugins go under `.sph/` rather than a `plugins/` directory at the repo root: it keeps them with the rest of sph's per-project state (`.sph/config.toml`) and away from source directories. A `package.json` can declare `sph.plugins: ["./a.ts", "./b.ts"]` for a multi-module plugin, `sph.name` to name it, and `sph.description` for the one-line summary shown in `/plugins`. A module that exports `{ description, setup }` instead of a bare factory can state that summary in its own code, which wins over the manifest — the sentence next to the implementation is the closer one. (Function-form plugins have nowhere to put it, so use the object form if you want one.)

A repository's `.sph/plugins/*.ts` is arbitrary code someone else wrote, so it goes behind the same trust gate as `AGENTS.md` and the sandbox: reading a stranger's repo must not execute what they shipped. Because third-party plugins outrank bundled ones, a workspace or user plugin **can** replace `sph-mcp` — legitimate for patching, but sph prints `plugin <name> shadows the bundled one` when it happens, since a swapped-out service is otherwise invisible. `sph-sandbox` is the exception: a same-named third-party plugin is ignored and the built-in confinement backend stays loaded. Replacing the sandbox silently would hand process isolation to whatever a repository shipped.

Turn one off in `config.toml`:

```toml
[plugins]
disabled = ["sph-mcp"]   # MCP's tool and service both disappear
```

Notes that save time:

- **Bundled vs third-party.** Code in `src/plugins/` is compiled with sph and can import core freely. Third-party plugins are loaded as TypeScript source by Node's type stripping, so they carry three constraints: **sibling imports need the `.ts` extension** (`./hub.ts`, not `./hub.js`), **only erasable syntax** (no `enum`, runtime `namespace`, or parameter properties), and **types from core, runtime from `api`** — `import type { … }` is erased and free, while a plain import cannot resolve, because core is in `dist/` and the plugin is not.
- **Runtime capability comes from `PluginApi`, including `host.mergeChildEnv`** for spawning — credential scrubbing is host policy, and re-implementing it means leaking `SPH_API_KEY` to third-party processes.
- **A broken plugin never blocks startup.** Import failures, bad default exports, `setup` throws, duplicate tool names, and duplicate service names all become warnings; the other plugins still load. Warnings print at startup and in `sph -p` (headless).
- Services are the only channel between plugins — there is no global registry and no importing each other's implementation. `sph-mcp` provides the service named `sph-mcp`, which is how `/mcps` reaches MCP without core knowing what MCP is.

### MCP servers

Servers are discovered from five sources. Later ones win on a name clash — a name resolves to the higher-priority definition as a whole (fields are not merged):

| Source | Scope | Notes |
|---|---|---|
| `~/.sph/config.toml` `[mcp_servers.<name>]` | user | table of tables, including `type` |
| `<repo>…<cwd>/.sph/config.toml` | project | walked root→cwd, closest wins |
| `~/.claude.json` | user + project | `mcpServers`, and `projects.<dir>.mcpServers` |
| `~/.codex/config.toml`, `<dir>/.codex/config.toml` | user + project | `[mcp_servers.<name>]`, incl. `env_vars` |
| `.mcp.json` | project | walked root→cwd, closest wins |

Priority is **sph, then the other external configs, then `.mcp.json`**, and within a tool project beats user. Malformed entries in foreign files degrade to warnings — they never block startup.

External files are **never written to**. To turn a server off — including one another tool declares — write a same-name entry in `~/.sph/config.toml`; it replaces the lower-priority definition whole, so it does not even need a `command`:

```toml
[mcp_servers.noisy-server]
disabled = true
```

Every enabled server connects **in the background at startup** (no lazy mode); a server that fails to start shows up as a problem in `/mcps` instead of blocking the first frame.

`/mcps` can add and remove entries, but only in sph's own config. Only **stdio** servers run; HTTP entries are still discovered and listed as unsupported rather than dropped, so "I configured it but nothing happened" always has a visible answer.

Request timeouts: control requests (`initialize`, `tools/list`) cap at 15s; `tools/call` caps at 60s by default because build, browser, and crawl servers routinely run longer. Per-server override — accepted in sph's own `[mcp_servers.<name>]` (and tolerated as an sph extension in external configs):

```toml
[mcp_servers.browser]
command = "npx"
call_timeout_ms = 120_000   # tools/call only; control requests keep the 15s cap
```

The value takes effect on the next call — hot reload does not restart the connection for it.

If MCP is not wanted at all, disable the plugin rather than the servers — `/mcps` then says so instead of showing an empty list:

```toml
[plugins]
disabled = ["sph-mcp"]
```

`--output-format json` emits one JSON object per agent event, ending with a `result` line, so scripts do not have to reassemble deltas:

```bash
sph -p "summarise the build errors" --output-format json | jq -r 'select(.type=="result").text'
```

Exit codes: `0` ok, `1` error, `2` usage or configuration.

## Security model

Three independent layers, all failing closed:

1. **Workspace trust.** A workspace must be trusted before the agent runs — `AGENTS.md` and the tools act inside it. `--trust` remembers it; the TUI asks once. Trust on a parent directory covers descendants, never the other way round.
2. **Sandbox.** `off` (default) / `workspace` / `read-only`. The confined modes are a same-host file policy, not a container: Linux uses `bwrap` (read-only host root, private pid namespace) and falls back to Landlock; macOS uses Seatbelt (`sandbox-exec`); Windows uses a restricted token and ACL write grants. **Reads and network stay on the host.** Windows (and Landlock) enforcement is partial: hardlinks and unconfined reads are known gaps. Denials are policy, not bugs — the prompt tells the model not to retry them by another route.
3. **Approval.** `ask` (default) prompts per reviewed tool; `auto` sends the call to an LLM reviewer that denies when unsure; `yolo` allows everything. In headless mode `shell`, `web_search`, and `mcp` are denied unless approval is `yolo`. The dialog's two *always allow* options are scoped to **that exact action** — a specific shell command, MCP tool, or path — never the whole tool, so approving `npm test` does not silently approve `rm -rf`. *For this session* lives in memory; *for this project* is written to `[grants]` in config.toml keyed by the git repo root, so a grant made in a subdirectory covers the whole repository. `[permissions]` rules sit above all of this: a `deny` rule is a hard boundary no mode can cross.

Path handling canonicalises through `realpath` and rejects anything escaping the workspace root — including symlinked directories encountered while searching (a symlink is never traversed).

## State on disk

Everything user-level lives under `~/.sph/` and never in the repository:

| Path | Purpose |
|---|---|
| `config.toml` | configuration and cross-session state (trusted roots, `[grants]`); rewritten surgically by the TUI so comments and key order survive |
| `models.json` | hand-written endpoint and model declarations (`providers` table) |
| `sessions/<ws-key>/<id>.jsonl` | append-only session records (`message` / `event`), plus `current.json` pointer |
| `spill/` | oversized tool results, kept out of context and referenced by path |
| `plugins/` | third-party plugins, loaded in every project |

Project-local state uses the same name inside the repository: `<workspace>/.sph/config.toml`, which is read from the workspace root down to the current directory (closest wins), and `<workspace>/.sph/plugins/`, a single directory at the workspace root that loads only when the workspace is trusted.

Malformed session lines are skipped rather than failing the file. Multiple `sph` processes can run in the same directory (each gets its own conversation); `-c` / `--resume` of a session that is already open exits immediately.

## Architecture

```
src/
├── cli/         entry, arg parsing, runtime assembly. bootstrap asks plugins for services
├── agent/       turn contract (driver.ts) and the event protocol. The loop itself is sph-loop
├── llm/         client seam only (LlmClient, reasoning effort). Adapters live in sph-llm
├── tools/       tool contract and the registry. The tools themselves live in sph-tools
├── session/     SessionPort only. JSONL, lock, fold, and export live in sph-session
├── sandbox/     mode, fail-closed, read-only write denial. OS backends live in sph-sandbox
├── permission/  approval policy. This stays in the host: it is the safety check, not a feature
├── config/      which plugins are disabled, credentials, models.json
├── workspace/   path boundary, root resolution, trust
├── tui/         terminal widgets, split by module: screen/ terminal/ input/ widgets/ text/.
│                Entry is `src/tui/index.ts`; product UI stays in sph-tui
└── plugins/     host, loader, seams, and the bundled implementations:
                 sph-llm, sph-tools, sph-skills, sph-session, sph-storage,
                 sph-loop, sph-schedule, sph-tui,
                 sph-mcp, sph-todo, sph-plan, sph-sandbox, sph-subagent
```

Both UI trees are grouped by feature rather than by layer. `src/tui` splits into the render core (`screen`), terminal plumbing (`terminal`), input (`input`), reusable widgets (`widgets`), and text measurement (`text`). `src/plugins/sph-tui` splits into the regions and concerns of the product UI — `header`, `footer`, `messages`, `tools`, `interaction`, `input`, `commands`, `transcript`, `theme`, `trust` — and keeps only the process entry (`index.ts`), the dependency surface (`deps.ts`), the main loop (`interactive-mode.ts`), the dialog primitives (`dialogs.ts`), and the screen behaviour shared by the entry and the loop (`chrome.ts`) at its root.

### Import paths

Cross-module imports go through a single root alias instead of deep relative paths: `@/x` means `src/x` (so `@/tui/index.js` is the widget layer, `@/plugins/sph-loop/loop.js` a plugin, `@/util.js` a core module). It is declared in `tsconfig.json` as `paths` only — entries resolve relative to the config file, and `baseUrl` is deprecated as of TypeScript 6 and removed in 7.

`tsc` does not rewrite import specifiers, so `dist/` still contains `@/tui/index.js` — and Node would take that for a bare package name and fail with `ERR_MODULE_NOT_FOUND`. `src/cli/alias-resolver.ts` closes that gap: a side-effect module that registers a `resolve` hook mapping `@/*` onto the emitted tree. It is imported first by both process entries (`src/cli/index.ts`, `src/sdk.ts`), because ESM evaluates the dependency graph in import order and the hook has to be in place before anything else resolves. Under `tsx` the module is a no-op — `tsx` resolves the alias from `tsconfig.json` itself.

The CLI therefore boots in two steps: `src/cli/index.ts` registers the resolver and then dynamically imports `src/cli/main.ts`. The import has to be dynamic — a static one would resolve the whole graph before the resolver ran.

Within `src/tui` and `src/plugins/sph-tui` there are no relative imports left at all, so moving a file never needs a second edit elsewhere.

`src/tui/index.ts` is the widget layer's public API — tests and out-of-tree consumers import it. Call sites that sit on a **startup path** take deep paths instead, so a screen pays only for what it draws: the trust gate is the first thing a user sees and needs three files, but the barrel would pull the whole layer — editor, markdown (and `marked`), alt-screen diffing — to render a logo and a `y/n` prompt. That path went from ~825 ms to ~150 ms. The main interactive stack loads the layer in full regardless, so those call sites keep using the barrel. The same split applies to the alt-screen options: `chrome.ts` carries only the canvas colour and is what the trust gate takes, while the sticky user-message overlay lives in `transcript-chrome.ts` — structurally out of reach until there is a transcript to stick.

Startup resolves `sph-llm`, `sph-session`, `sph-loop`, and `sph-schedule` by service name. If one of those is disabled, sph exits instead of running a turn with a missing half. `sph-sandbox` is the other required piece for `workspace` and `read-only`, and a same-named third-party plugin cannot replace it. Tools are not a service: `sph-tools` registers them into an otherwise empty tool table.

`src/plugins/services.ts` holds the seams. The host names a capability without importing its implementation.

Agent definitions and the `task` / `send_subagent_message` tools live in the plugin, while the child session, depth budget, approval, and event protocol stay in the turn loop. `task` spawns a child (`action: spawn`, the default) and also lists or reads background records (`list`, `get`). Built-in agents are `explore` and `research` (read-only), `writer` (documents only), and `general`. `/agent <name>` seats one of them as this session: the next turn keeps only that definition's tools and appends its prompt. `/agent default` returns to every tool. The choice is an `agent` event, so it survives resume and compaction. A missing definition falls back to every tool. A markdown file in `~/.sph/agents/` or `<workspace>/.sph/agents/` adds or replaces one; the workspace directory is read only when the workspace is trusted. A file looks like this:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, glob, ls
writes: false
---

Your system prompt goes here.
```

One turn of `runTurn` looks like this:

1. Inject anything that arrived at a safe point — background job completions, steering messages, `AGENTS.md` files touched by earlier tools.
2. Project the session into a request, compacting if it is over the pressure line.
3. Call the model, streaming text and reasoning to the UI.
4. No tool calls and an explicit finish reason → done. Otherwise run the tool batch, committing results in model order.
5. Persist, then repeat until the model stops. A subagent also stops at `max_turns`, or at 20 calls when that key is omitted.

## Development

```bash
npm run typecheck    # tsc over src/ including tests (no emit)
npm test             # typecheck, then node:test via tsx
npm run build        # emit dist/ (tests excluded)
npm run sph -- -p "hi"   # run from source
```

Notes for contributors:

- **Tests live in `tests/`, mirroring `src/`.** `tsconfig.json` excludes `*.test.ts` from the build (and never sees `tests/`), so `tsconfig.test.json` exists purely to check tests together with sources; `pretest` runs it. An untyped test file fails only at runtime otherwise.
- Tests use `node:test` and the built-in assert module. No test framework.
- Comments record *why* — the constraint, the failure that motivated it, what was tried — rather than restating the code.
- **Gestures and key bindings live in `docs/interactions.md`.** It is the single source of truth for what a click, a double-click, a wheel, or a chord means on each surface — visual style has `theme.ts`, and this is its counterpart. Pick a gesture from that table before adding a surface; if you need a new reading, change the table (with the reason) first.
- New behaviour that a user can depend on should come with a test that fails when the behaviour is removed.

## Known limitations

- **Sandbox enforcement is partial on Windows and on Landlock.** Windows confines writes via a restricted token and ACLs; reads, network, and hardlinks are not confined. Linux `bwrap` covers the promised writes and hides host processes. macOS Seatbelt denies file writes outside the allow-list. The sandbox is off unless `sandbox` is set to `workspace` or `read-only`.
- **Context windows are not auto-discovered.** Upstream `/models` endpoints generally do not report them, so `context_window` is configured per model; an unconfigured new model falls back to the configured default and may be over-estimated until the provider rejects it.
- **Windows ACL grants are machine-scoped for `~/.sph`.** The capability SID derives from the path, so it is shared across workspaces; it is revoked on exit unless another `sph` session is still running.
- **One protocol per process.** `--api` applies to the main model; auxiliary calls follow `[aux].api` or the main protocol.
- **No cost accounting.** The budget is denominated in tokens, not money — there are no per-model price tables.
- `sph sessions` lists but does not delete.

## License

MIT — see [LICENSE](LICENSE).
