# Spring Harness (`sph`)

A personal, general-purpose agent runtime that runs on your own machine: one process, a terminal UI, and a tool-using LLM loop over a single workspace.

It is written from scratch in TypeScript with five runtime dependencies — no CLI framework, no TUI framework, no HTTP client wrapper. That is a deliberate constraint rather than a boast: the parts that decide behaviour (the agent loop, the context budget, the terminal renderer, the sandbox) are the parts you can read end to end.

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
sandbox = "workspace"
```

Key facts:

- Endpoints live in `models.json`, not in `config.toml`: `baseUrl`, `api` (`chat-completions` | `responses` | `anthropic-messages`, set per provider and overridable per model), `apiKey`, `headers`, and `compat`. `apiKey` and header values support `$VAR` / `${VAR}` interpolation; an explicitly empty `apiKey` means *send no auth header* (pair it with provider `headers` so keyless gateways can identify the session). There is no global `SPH_API_KEY` any more — each provider carries its own key reference.
- Per-model declarations supply `name`, `contextWindow`, and `maxTokens`; `config.toml`'s `context_window` / `max_tokens` are fallbacks for undeclared models. `--model provider/id` switches provider and model in one go; `/model` lists every declared model across providers and writes the selection back to `config.toml`.
- `provider` (config.toml) selects the endpoint; `[aux] provider` (optional) routes the summariser and `auto`-approval reviewer at another declared provider — that is what makes a cross-vendor cheap summariser possible. `compact_model` / `review_model` are model ids resolved against that provider.
- `compat` is declared per provider (defaults for its models) and merged per model. Declared bits override URL inference; `prompt_cache = false` in config.toml vetoes cache-related bits.
- `prompt_cache` (default `true`) places Anthropic prompt-cache breakpoints. OpenAI-side cache routing (`prompt_cache_key`) is sent only for `api.openai.com`, or when compat opts in. `prompt_cache_retention` is off unless declared. Unknown gateways get a conservative first request; rejected optional fields are dropped, logged as `compat_retry` in the session file, and shown on the working-status line with a count. The system prompt is frozen within a turn and the mechanical-stub boundary is pinned once it first engages, so the request prefix stays byte-stable; whole-prompt cache misses are logged as `cache_miss` events in the session file rather than shown in the UI.
- `max_session_tokens` (default `0` = unlimited) caps cumulative prompt+completion tokens for the whole agent tree, including subagents and compaction. The count survives `--resume`; the turn stops before the next request when the budget is gone, and warns at 80%.
- `max_retries` (default `10`) is how many times a failed upstream request is retried, not counting the first attempt. `0` fails immediately. Only 408/429/5xx, network errors, idle timeouts, and empty responses retry.
- `subagent_max_depth` (default `1`) — `0` forbids delegation entirely.
- `subagent_approval` (default `inherit`) — `strict` makes subagents fail closed: reviewed tools are denied without prompting, and the parent session's grants are not shared. `inherit` hands the child the same approver, grants included.
- `[permissions]` — `allow` / `ask` / `deny` lists whose entries are `<tool>` or `<tool>:<pattern>` (`*` any run, `?` one character; no wildcard means an exact match). Rules are more specific than the mode, so they outrank it: **`deny` beats every mode including `yolo`**, `ask` also beats `yolo`, and `allow` skips the prompt. In headless mode an `ask` rule is a denial — there is nobody to ask.
- `trusted = [...]` (top level) and `[grants]` record cross-session state in config.toml itself: trusted workspace roots, and per-project approval grants keyed by git repo root. Both are written by sph when you confirm a workspace or pick *always allow* in the approval dialog.

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

TUI commands: `/help` `/new` `/resume` `/skills` `/mcps` `/plan` `/goal` `/compact` `/model` `/effort` `/permission`. `/resume <id>` switches straight to a session and bare `/resume` opens the picker; `/sessions` is an alias. `/compact [instructions]` folds older history into a checkpoint on demand, optionally steering what the summary emphasises. `/permission` sets the approval mode (`ask | auto | yolo`) and writes it back to `config.toml` as the `approval` key. `/skills` re-scans the skill roots on every open, and `/mcps` reports live server status and lets you enable/disable, add, remove, and reload — all reflect the current state rather than what the running turn started with.

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

Malformed session lines are skipped rather than failing the file. Multiple `sph` processes can run in the same directory (each gets its own conversation); `-c` / `--resume` of a session that is already open exits immediately.

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
├── permission/  approval policy + the LLM safety reviewer + grant store
├── config/      TOML load/validate, models.json registry, surgical save
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
- `sph sessions` lists but does not delete.

## License

MIT — see [LICENSE](LICENSE).
