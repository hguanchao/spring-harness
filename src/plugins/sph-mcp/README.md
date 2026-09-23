# sph-mcp

MCP support for sph, delivered as a plugin. It is the worked example of the plugin
contract: read this directory together with `src/plugins/types.ts`.

## What it provides

| Kind | Name | Consumer |
|---|---|---|
| Tool | `mcp` | the model (`action: list \| call`) |
| Service | `sph-mcp` | `/mcps`, reports, and `runTurn`'s prompt (server/tool listings) |

Disabling the plugin removes both:

```toml
[plugins]
disabled = ["sph-mcp"]
```

## Files

| File | Role |
|---|---|
| `index.ts` | The plugin entry: builds the hub, registers the tool, provides the service, registers cleanup. |
| `tool.ts` | The model-facing `mcp` tool. |
| `hub.ts` | JSON-RPC client (stdio, HTTP, SSE) with lazy reconnect and tool-list sync. |
| `remote.ts` | Streamable HTTP and legacy SSE links. |
| `transport.ts` | Which of the three transports a server declaration uses. |
| `sources.ts` | Discovers servers from five config sources and merges them by priority. |
| `win-command.ts` | Windows command resolution (`PATH × PATHEXT`, `.cmd`/`.bat` via `cmd.exe`). |

## This is a bundled plugin

It sits next to the plugin system inside `src/plugins/`, so **it is part of the tsc build** and
loads as compiled JS from `dist/plugins/sph-mcp/`. That exempts it from two things a third-party
plugin must obey — and it is the reason the loader only accepts *directory* plugins in this root,
since `loader.ts` / `host.ts` / `types.ts` live right here.

A plugin under `~/.sph/plugins/` or `<workspace>/.sph/plugins/` is loaded from TypeScript source
by Node's type stripping instead, and must respect all four rules below. This plugin follows them
anyway so the directory stays a usable template.

## Constraints every plugin obeys

From `src/plugins/types.ts`; not MCP-specific.

1. **Types from core, runtime from `api`.** `import type { PluginHostFacts } from '../types.js'` is erased at runtime and therefore free; a plain runtime import is not resolvable, because a third-party plugin runs from `.sph/plugins/` while core is in `dist/`.
2. **`.ts` extensions on sibling imports** (third-party only). Node's type stripping does no `.js` → `.ts` substitution.
3. **Erasable syntax only** (third-party only). No `enum`, no runtime `namespace`, no constructor parameter properties.
4. **Credential scrubbing comes from the host.** `hub.ts` takes `mergeChildEnv` through `PluginHostFacts` rather than calling `process.env`: spawning a third-party server with the raw parent environment would hand it `SPH_API_KEY`.

## Why the hub takes host facts

`McpHub` needs exactly one host policy — `mergeChildEnv` — so its constructor takes
`PluginHostFacts` instead of importing `src/sandbox/env.ts`. That is the whole reason
discovery and loading live here too: once the plugin owns the hub, it must own the reload
path, and `reload()` is the only load path (`connect()` is its first call).

Core hands over **host facts** (workspace, start dir, `[mcp]` preferences, trust state) via
`McpReloadOptions`; the plugin supplies the **MCP domain logic**. Core has no MCP source
list, no priority rules, and no server registry to search for.
