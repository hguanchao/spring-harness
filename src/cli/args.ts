import { API_PROTOCOLS, parseSandboxMode, type ApiProtocol } from '../config/load.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/openai.js';
import type { ApprovalMode } from '../approval/policy.js';
import type { SandboxMode } from '../sandbox/types.js';

export type OutputMode = 'text' | 'json' | 'stream-json';

export interface CliArgs {
  help: boolean;
  prompt?: string;
  newSession: boolean;
  fork: boolean;
  yolo: boolean;
  /** 把当前工作区写入 ~/.sph/trusted.json，记为已信任；未信任工作区跑 -p 前必须带上。。 */
  trust: boolean;
  sandbox?: SandboxMode;
  model?: string;
  effort?: ReasoningEffort;
  api?: ApiProtocol;
  /** 单次输出上限；--max-tokens 覆盖 config.toml 的 max_tokens。 */
  maxTokens?: number;
  approval?: ApprovalMode;
  output: OutputMode;
  schemaPath?: string;
  resumeId?: string;
  /** 位置子命令：sph sessions / sph export。 */
  command?: 'sessions' | 'export';
  search?: string;
  format: 'md' | 'json';
  sessionId?: string;
}

export const HELP = `Spring Harness (sph)

Usage:
  sph                       Interactive TUI (needs a terminal; non-TTY exits with usage)
  sph -p "<prompt>"         One headless turn, then exit
  sph -p "..." --output json        Print a single JSON result object
  sph -p "..." --output stream-json Print NDJSON agent events
  sph -p "..." --schema s.json      Ask the model for JSON matching the schema file
  sph --resume <id>         Resume a specific session (see: sph sessions)
  sph -c                    Start a new session
  sph --fork                Fork the current session JSONL into a new id
  sph sessions [--search kw]        List (or keyword-filter) sessions of this workspace
  sph export [--format md|json] [--session id]   Export a session to stdout
  sph --model <model>       Override the configured model for this process
  sph --effort <level>      Reasoning effort: off | low | medium | high | xhigh | max
  sph --max-tokens <n>      Max output tokens per completion (overrides config max_tokens)
  sph --api <protocol>      Upstream protocol: chat-completions | responses | anthropic-messages
  sph --approval MODE       ask | auto | yolo (default: ask; LLM reviews in auto)
  sph --yolo                Shortcut for --approval yolo
  sph --trust               Remember this workspace as trusted (required for untrusted -p)
  sph --sandbox MODE        off | workspace | read-only  (default: workspace)

TUI keys: /            command menu (Up/Down pick, Enter run)
          Ctrl+K       all actions (sessions, model, approval, export, ...)
          Wheel / PgUp / PgDn  scroll the conversation view (full-screen UI)
          Up / Down    prompt history
          Esc          back to latest / abort the running turn / cancel a prompt
          Ctrl+L       clear the view
          Ctrl+C       abort the running turn; press twice to exit
          Ctrl+D       exit (when the input is empty)
TUI commands: /help /new /sessions /switch /status /plan /model /effort
              /approval /todo /jobs /export /clear /quit

OS sandbox: Windows restricted token + ACL, or Linux bwrap. macOS is unsupported.
Enforcement is PARTIAL. Headless shell/web/mcp is denied unless --yolo is set.
Untrusted workspaces: -p requires --trust; the TUI asks once interactively.
--yolo does not imply --trust.
Exit codes: 0 ok, 1 error, 2 usage/config, 3 --schema output was not valid JSON.
`;

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { help: false, newSession: false, fork: false, yolo: false, trust: false, output: 'text', format: 'md' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '-c' || arg === '--new') out.newSession = true;
    else if (arg === '--fork') out.fork = true;
    else if (arg === '--yolo') {
      out.yolo = true;
      out.approval = 'yolo';
    }
    else if (arg === '--trust') out.trust = true;
    else if (arg === '--approval') {
      const value = argv[++i];
      if (value !== 'ask' && value !== 'auto' && value !== 'yolo') {
        throw new Error('--approval must be one of: ask | auto | yolo');
      }
      out.approval = value;
    }
    else if (arg === '--resume') {
      out.resumeId = argv[++i];
      if (!out.resumeId) throw new Error('--resume requires a session id (see: sph sessions)');
    } else if (arg === '-p' || arg === '--prompt') {
      out.prompt = argv[++i];
      if (!out.prompt) throw new Error('-p requires a prompt string');
    } else if (arg === '--sandbox') {
      const value = argv[++i];
      if (!value) throw new Error('--sandbox requires a value (off | workspace | read-only)');
      out.sandbox = parseSandboxMode(value);
    } else if (arg.startsWith('--sandbox=')) {
      out.sandbox = parseSandboxMode(arg.slice('--sandbox='.length));
    } else if (arg === '--model') {
      out.model = argv[++i];
      if (!out.model) throw new Error('--model requires a model name');
    } else if (arg === '--effort') {
      const value = argv[++i];
      if (!value || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
        throw new Error(`--effort must be one of: ${REASONING_EFFORTS.join(' | ')}`);
      }
      out.effort = value as ReasoningEffort;
    } else if (arg === '--max-tokens') {
      out.maxTokens = parseMaxTokens(argv[++i]);
    } else if (arg.startsWith('--max-tokens=')) {
      out.maxTokens = parseMaxTokens(arg.slice('--max-tokens='.length));
    } else if (arg === '--api') {
      const value = argv[++i];
      if (!value || !(API_PROTOCOLS as readonly string[]).includes(value)) {
        throw new Error(`--api must be one of: ${API_PROTOCOLS.join(' | ')}`);
      }
      out.api = value as ApiProtocol;
    } else if (arg === '--output') {
      out.output = parseOutputMode(argv[++i]);
    } else if (arg.startsWith('--output=')) {
      out.output = parseOutputMode(arg.slice('--output='.length));
    } else if (arg === '--schema') {
      out.schemaPath = argv[++i];
      if (!out.schemaPath) throw new Error('--schema requires a JSON schema file path');
    } else if (arg === '--search') {
      out.search = argv[++i] ?? '';
    } else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'md' && value !== 'json') throw new Error(`--format must be md | json, got: ${value}`);
      out.format = value;
    } else if (arg === '--session') {
      out.sessionId = argv[++i];
      if (!out.sessionId) throw new Error('--session requires a session id');
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    const command = positional[0];
    if (command === 'sessions' || command === 'export') {
      out.command = command;
    } else {
      throw new Error(`unknown argument: ${command}`);
    }
  }
  if (out.schemaPath && out.output === 'text') out.output = 'json';
  return out;
}

/** --output 的两种写法（`--output v` / `--output=v`）共用同一处校验，避免规则漂移。 */
function parseOutputMode(value: string | undefined): OutputMode {
  if (value !== 'text' && value !== 'json' && value !== 'stream-json') {
    throw new Error(`--output must be text | json | stream-json, got: ${value}`);
  }
  return value;
}

/** 只接受十进制正整数，拒绝小数 / 负数 / 科学计数法 / 超安全整数范围的值。 */
function parseMaxTokens(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('--max-tokens must be a positive integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('--max-tokens must be a positive integer');
  return n;
}

