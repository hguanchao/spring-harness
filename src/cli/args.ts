import { API_PROTOCOLS, parseSandboxMode, type ApiProtocol } from '../config/load.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/openai.js';
import type { ApprovalMode } from '../approval/policy.js';
import type { SandboxMode } from '../sandbox/types.js';

export interface CliArgs {
  help: boolean;
  prompt?: string;
  /** `--new`：显式声明新建会话。默认行为，脚本里写出来更自述。 */
  newSession: boolean;
  /** `-c` / `--continue`：续用本工作区最近一次会话。 */
  continueSession: boolean;
  yolo: boolean;
  /** 把当前工作区写入 ~/.sph/trusted.json，记为已信任；未信任工作区跑 -p 前必须带上。 */
  trust: boolean;
  sandbox?: SandboxMode;
  model?: string;
  effort?: ReasoningEffort;
  api?: ApiProtocol;
  /** 单次输出上限；--max-tokens 覆盖 config.toml 的 max_tokens。 */
  maxTokens?: number;
  approval?: ApprovalMode;
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
  sph --resume <id>         Resume a specific session (see: sph sessions)
  sph -c, --continue        Continue the most recent session of this workspace
  sph --new                 Start a new session (default; explicit for scripts)
  sph sessions [--search kw]        List (or keyword-filter) main sessions of this workspace
                                    (subagent transcripts are listed only under their main session)
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
TUI commands: /help /new /sessions /recap /status /goal /model /effort
              /approval /todo /jobs /export /clear /quit
              (/summarize is an alias of /recap; a recap is also generated
              automatically when you come back after being away)

OS sandbox: Windows restricted token + ACL, or Linux bwrap. macOS is unsupported.
Enforcement is PARTIAL. Headless shell/web/mcp is denied unless --yolo is set.
Untrusted workspaces: -p requires --trust; the TUI asks once interactively.
--yolo does not imply --trust.
Exit codes: 0 ok, 1 error, 2 usage/config.
`;

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    help: false,
    newSession: false,
    continueSession: false,
    yolo: false,
    trust: false,
    format: 'md',
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--new') out.newSession = true;
    else if (arg === '-c' || arg === '--continue') out.continueSession = true;
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
  if (out.newSession && out.continueSession) throw new Error('--new cannot be combined with --continue');
  return out;
}

/** 只接受十进制正整数，拒绝小数 / 负数 / 科学计数法 / 超安全整数范围的值。 */
function parseMaxTokens(value: string | undefined): number {
  const n = value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('--max-tokens must be a positive integer');
  return n;
}
