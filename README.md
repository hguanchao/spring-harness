# Spring Harness (`sph`)

A personal, general-purpose agent runtime that runs on your own machine: one process, a terminal UI, and a tool-using LLM loop over a single workspace.

It is written from scratch in TypeScript with six runtime dependencies — no CLI framework, no TUI framework, no HTTP client wrapper. That is a deliberate constraint rather than a boast: the parts that decide behaviour (the agent loop, the context budget, the terminal renderer, the sandbox) are the parts you can read end to end.

- **Agent loop** — multi-step tool calling with an explicit 32-step ceiling, parallel-safe tool batching, and results committed in model order.
- **Context management** — three-tier compaction (tool-result stubbing → LLM incremental summary → mechanical fold) plus recovery when a provider rejects the request as over-window.
- **Subagents** — foreground fan-out (3 concurrent), background jobs with completion push, `resume_from`, and optional `git worktree` isolation. Flat tree by default.
- **Sessions** — append-only JSONL per workspace; state (todos, goal, plan mode, token spend) is folded back on resume.
- **Sandbox** — Windows restricted token + ACL, or Linux `bwrap`. Enforcement is *partial* and described as such, in the prompt and here.
- **Three upstream protocols** — `chat-completions`, `responses`, `anthropic-messages`, with runtime parameter degradation so an endpoint that rejects `max_tokens` or `stream_options` is adapted to instead of failing.
- **MCP** — stdio servers discovered from five config sources, with lazy reconnect and hot reload. On Windows, bare commands (`npx`…) are resolved via `PATH × PATHEXT`; `.cmd`/`.bat` launchers run through `cmd.exe` with cmd-safe escaping (a bare `npx` is not an `.exe`, so naive spawning fails with ENOENT).
- **Skills** — `SKILL.md` catalogs discovered from four roots.

## Requirements

- Node.js **>= 22**
- Windows or Linux for the sandbox. **macOS is not supported** — `sph` refuses to start rather than pretend to confine.

## Install

```bash
npm install          # also builds (prepare hook)
npm run build        # tsc -> dist/
npm link             # optional: puts `sph` on PATH
```

## Configure

`sph` reads `~/.sph/config.toml`. Running it without one prints a full template and exits with code 2. A minimal working file:

```toml
base_url = "https://api.example.com/v1"
model = "example-model"
context_window = 256000
sandbox = "workspace"
```

Key facts:

- The API key comes from `SPH_API_KEY` (wins) or `api_key`. An explicitly empty `api_key = ""` means *send no auth header* — for keyless gateways that identify the session through `[http_headers]`.
- `api` selects the upstream protocol; default is `chat-completions`.
- `compact_model` / `review_model` point the summariser and the `auto`-approval reviewer at cheaper models.
- `[aux]` (optional) gives those auxiliary calls a *different* endpoint — `base_url` / `api_key` / `api`, each individually optional. This is what makes a cross-vendor cheap summariser possible.
- `prompt_cache` (default `true`) places Anthropic prompt-cache breakpoints and sends OpenAI-side cache routing (`prompt_cache_key` + session affinity headers + 24h retention). Rejected parameters are dropped automatically on the next attempt. The system prompt is frozen within a turn and the mechanical-stub boundary is pinned once it first engages, so the request prefix stays byte-stable; whole-prompt cache misses are logged as `cache_miss` events in the session file rather than shown in the UI.
- `max_session_tokens` (default `0` = unlimited) caps cumulative prompt+completion tokens for the whole agent tree, including subagents and compaction. The count survives `--resume`; the turn stops before the next request when the budget is gone, and warns at 80%.
- `subagent_max_depth` (default `1`) — `0` forbids delegation entirely.

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

Useful flags: `--model`, `--effort` (`off|low|medium|high|xhigh|max`), `--max-tokens`, `--api`, `--approval ask|auto|yolo`, `--sandbox off|workspace|read-only`, `--trust`.

Theming: sph ships a fixed dark palette. Set `SPH_THEME=terminal` to drop hardcoded colors and emit basic ANSI codes instead, so the TUI follows your terminal emulator's own 16-color theme (canvas becomes the terminal's default background).

TUI commands: `/help` `/new` `/sessions` `/skills` `/mcps` `/plan` `/goal` `/model` `/effort` `/approval`. `/skills` re-scans the skill roots on every open, and `/mcps` reports live server status and lets you enable/disable, add, remove, and reload — all reflect the current state rather than what the running turn started with.

### MCP servers

Servers are discovered from five sources. Later ones win on a name clash — a name resolves to the higher-priority definition as a whole (fields are not merged):

| Source | Scope | Notes |
|---|---|---|
| `~/.sph/config.toml` `[[mcp_servers]]` | user | native |
| `<repo>…<cwd>/.sph/config.toml` | project | walked root→cwd, closest wins |
| `~/.claude.json` | user + project | `mcpServers`, and `projects.<dir>.mcpServers` |
| `~/.codex/config.toml`, `<dir>/.codex/config.toml` | user + project | `[mcp_servers.<name>]`, incl. `env_vars` |
| `.mcp.json` | project | walked root→cwd, closest wins |

Priority is **sph > Claude > Codex > `.mcp.json`**, and within a tool project beats user. Malformed entries in foreign files degrade to warnings — they never block startup.

External files are **never written to**. Enable/disable is recorded as a local preference in `~/.sph/config.toml`:

```toml
[mcp]
disabled_servers = ["noisy-server"]   # turn off something a source enables
enabled_servers  = ["one-that-ships-off"]  # turn on what a source disables
```

`/mcps` can add and remove entries, but only in sph's own config. Only **stdio** servers run; HTTP entries are still discovered and listed as unsupported rather than dropped, so "I configured it but nothing happened" always has a visible answer.

`--output-format json` emits one JSON object per agent event, ending with a `result` line, so scripts do not have to reassemble deltas:

```bash
sph -p "summarise the build errors" --output-format json | jq -r 'select(.type=="result").text'
```

Exit codes: `0` ok, `1` error, `2` usage or configuration.

## Security model

Three independent layers, all failing closed:

1. **Workspace trust.** A workspace must be trusted before the agent runs — `AGENTS.md` and the tools act inside it. `--trust` remembers it; the TUI asks once. Trust on a parent directory covers descendants, never the other way round.
2. **Sandbox.** `off` / `workspace` (default) / `read-only`. Filesystem and process confinement come from the OS: a Windows restricted token with ACL write grants, or Linux `bwrap` mounts. **Reads, network, and hardlinks are not confined.** Denials are policy, not bugs — the prompt tells the model not to retry them by another route.
3. **Approval.** `ask` (default) prompts per reviewed tool; `auto` sends the call to an LLM reviewer that denies when unsure; `yolo` allows everything. In headless mode `shell`, `web_search`, and `mcp` are denied unless approval is `yolo`.

Path handling canonicalises through `realpath` and rejects anything escaping the workspace root — including symlinked directories encountered while searching (a symlink is never traversed).

## State on disk

Everything user-level lives under `~/.sph/` and never in the repository:

| Path | Purpose |
|---|---|
| `config.toml` | configuration; rewritten surgically by the TUI so comments and key order survive |
| `sessions/<ws-key>/<id>.jsonl` | append-only session records (`message` / `event`), plus `current.json` pointer |
| `trusted.json` | trusted workspace roots |
| `models.json` | per-endpoint model catalog cache and user-entered capacity hints |
| `spill/` | oversized tool results, kept out of context and referenced by path |

Malformed session lines are skipped rather than failing the file, and a second `sph` on the same workspace exits immediately (session lock).

## Architecture

```
src/
├── cli/         entry, arg parsing, runtime assembly (bootstrap), output formats
├── agent/       loop.ts (the turn loop) · prompt.ts · compact.ts · tool-run.ts
│                memory.ts (AGENTS.md) · plan.ts · recap.ts · subagent-prompt.ts
├── tools/       the 17 tools + capability sets and permission helpers
├── llm/         protocol adapters, SSE client, retry, error classification, compat caps
├── tui/         self-contained terminal UI: core/ (framework) + components/ (app)
├── sandbox/     OS confinement: open.ts dispatches to windows/ or linux.ts
├── session/     JSONL store, event folding, repair, locking, export
├── mcp/         stdio MCP client
├── runtime/     in-process shared resources: jobs, todos, spill, worktrees
├── approval/    approval policy + the LLM safety reviewer
├── config/      TOML load/validate and surgical save
├── workspace/   path boundary, root resolution, trust
└── skills/      SKILL.md catalog scanning
```

One turn of `runTurn` looks like this:

1. Inject anything that arrived at a safe point — background job completions, steering messages, `AGENTS.md` files touched by earlier tools.
2. Project the session into a request, compacting if it is over the pressure line.
3. Call the model, streaming text and reasoning to the UI.
4. No tool calls and an explicit finish reason → done. Otherwise run the tool batch, committing results in model order.
5. Persist, then repeat — up to 32 steps.

## Development

```bash
npm run typecheck    # tsc over src/ including tests (no emit)
npm test             # typecheck, then node:test via tsx
npm run build        # emit dist/ (tests excluded)
npm run sph -- -p "hi"   # run from source
```

Notes for contributors:

- **Tests are type-checked.** `tsconfig.json` excludes `*.test.ts` from the build, so `tsconfig.test.json` exists purely to check them; `pretest` runs it. An untyped test file fails only at runtime otherwise.
- Tests use `node:test` and the built-in assert module. No test framework.
- Comments record *why* — the constraint, the failure that motivated it, what was tried — rather than restating the code.
- New behaviour that a user can depend on should come with a test that fails when the behaviour is removed.

## Known limitations

- **Sandbox enforcement is partial.** Windows confines writes via a restricted token and ACLs; reads, network, and hardlinks are not confined. Linux uses `bwrap` bind mounts. macOS is unsupported.
- **Context windows are not auto-discovered.** Upstream `/models` endpoints generally do not report them, so `context_window` is configured per model; an unconfigured new model falls back to the configured default and may be over-estimated until the provider rejects it.
- **Windows ACL grants are machine-scoped for `~/.sph`.** The capability SID derives from the path, so it is shared across workspaces; it is revoked on exit unless another `sph` session is still running.
- **One protocol per process.** `--api` applies to the main model; auxiliary calls follow `[aux].api` or the main protocol.
- **No cost accounting.** The budget is denominated in tokens, not money — there are no per-model price tables.
- `sph sessions` lists but does not delete; there is no manual `/compact`.

## License

MIT — see [LICENSE](LICENSE).
