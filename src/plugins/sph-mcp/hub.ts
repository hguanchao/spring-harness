import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { PluginHostFacts } from '../types.js';
import { openHttpLink, openSseLink, type JsonRpcMessage, type RemoteLink } from './remote.js';
import { resolveTransport, type McpTransportName } from './transport.js';
import { cmdArgumentLine, resolveWindowsCommand } from './win-command.js';

/**
 * `error instanceof Error ? message : String(error)`。
 * 本地三行，不值得为它撑大宿主 api 面。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 关掉 stdio 子进程，并放开它占着的管道。
 *
 * Windows 上 `cmd.exe /c` 拉起的 MCP 会把管道继承给孙进程。只 `kill` 直接子进程时，
 * 孙进程还握着管道，父进程的 socket 不结束，事件循环退不掉，shell 提示符就不回来。
 */
export function stopStdioChild(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (process.platform === 'win32' && pid !== undefined) {
    // 必须先于 child.kill()。先杀掉 cmd 会让孙进程改挂到别处，随后的 taskkill /T 就找不到它。
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    try {
      execFileSync(join(root, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      try {
        child.kill();
      } catch {
        // 进程已经退出，或 taskkill 不可用时直接子进程也杀不掉。
      }
    }
  } else {
    try {
      child.kill();
    } catch {
      // 进程从未成功启动或已经退出。
    }
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

export interface McpServerConfig {
  /** 表头上的 ID。调用与启停都用它，不用来自表内的 `name`。 */
  name: string;
  /** 表内可选的 `name`，只用于展示。 */
  title?: string;
  /** stdio 启动命令。与 `url` 二选一；都没有的条目无效。 */
  command?: string;
  args?: string[];
  /** 追加到子进程环境之上。外部配置里的 env 表直接落到这里。 */
  env?: Record<string, string>;
  /**
   * 远程端点。`transport` 省略时路径以 `/sse` 结尾走 SSE，否则走可流式 HTTP。
   * 带 url 的条目必须被发现：配了却连不上，要比静默丢掉好查。
   */
  url?: string;
  /** 显式传输。外部配置里的 `type` 也归一到这里；写错的词留在这里，连之前就能报出来。 */
  transport?: string;
  /** 远程请求头。stdio 不用。 */
  headers?: Record<string, string>;
}

/** 一个定义的出处：展示标签 + 可否就地改写。 */
export interface McpOrigin {
  /** 展示标签，如 `~/.claude.json`、`.sph/config.toml`、`[mcp] disabled_servers`。 */
  label: string;
  /** 定义所在的文件路径；本地偏好来源指向 sph 用户配置。 */
  path: string;
  /**
   * sph 是否可以直接改写这个文件。
   *
   * 外部配置文件一律 false：写入别人的配置会带来
   * 意料之外的副作用，启停改为在 sph 自己配置里存一份本地偏好。
   */
  editable: boolean;
}

/** `reload()` 的输入。两个字段都可省，省略时取默认值，便于测试与内部构造。 */
export interface McpServerSpec extends McpServerConfig {
  /** 省略即启用。 */
  enabled?: boolean;
  /**
   * 来源声明的启用态（叠加本地偏好之前）。
   *
   * 弹窗切换开关时要靠它判断该写哪个偏好列表：只留最终值就只能猜，猜错会在另一个列表里
   * 留下一条过期的强制项，日后来源改了自己的默认值就会被它悄悄盖住。
   */
  sourceEnabled?: boolean;
  /** true = 不随 reload 拉起，首次 call / list(server) 才连接。省略即立即连。 */
  lazy?: boolean;
  /** 省略时用中性标签。 */
  origin?: McpOrigin;
}

export interface McpTool {
  server: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** 一个 server 的现状，供 `/mcps` 之类的展示用。 */
export interface McpServerStatus {
  name: string;
  title?: string;
  transport: McpTransportName;
  /** false = sph 跑不了这个传输，或定义本身无效。 */
  supported: boolean;
  enabled: boolean;
  /** 来源声明的启用态；`enabled` 与它不同就说明本地偏好正在覆盖来源。 */
  sourceEnabled?: boolean;
  /** 首次使用才连接；与「连不上」区别在 problem——懒而未连的没有 problem。 */
  lazy: boolean;
  /** 子进程还活着。崩溃、从未连上、被禁用、不支持的传输都是 false。 */
  connected: boolean;
  /** 握手还在后台进行。启动不为此阻塞——这也是它存在的意义。 */
  connecting?: boolean;
  /** 启动命令行（stdio）或 URL（http）；连不上时用户最需要看到的就是它。 */
  target: string;
  /** 启用却没能工作时的原因；正常时 undefined。 */
  problem?: string;
  origin: McpOrigin;
  tools: McpTool[];
}

export interface McpReloadResult {
  /**
   * 同步就能确定的警告（配置无效、被禁用等）。**异步握手失败不在这里**——spawn 不等
   * 握手，失败走 `problems`（`listServers()` 可见）并回调 `onProblem`。
   */
  warnings: string[];
  added: string[];
  removed: string[];
  /** 命令签名变了、被重新拉起的（复用连接不算）。 */
  restarted: string[];
}

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface Wire {
  write(message: JsonRpc): void;
  close(): void;
  alive(): boolean;
}

interface Connection {
  /** stdio 子进程 pid，供测试确认关掉后进程真的没了。远程传输没有。 */
  pid?: number;
  wire: Wire;
  /** initialize + tools/list 都完成了。未就绪的连接只等待，不发业务请求。 */
  ready: boolean;
  tools: McpTool[];
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  /** stdio 未收全的行。远程传输不走这个缓冲。 */
  buffer: string;
}

interface Entry {
  spec: McpServerSpec & { enabled: boolean; origin: McpOrigin };
  /** 命令签名：不变就可以复用已有连接，热重载不必把正在用的工具抖掉。 */
  signature: string;
  /** 启用且是 stdio 时才为 true。 */
  spawnable: boolean;
  /** 不 spawnable 的原因，与 spawn 失败的原因合并进 status.problem。 */
  blocked?: string;
}

const NEUTRAL_ORIGIN: McpOrigin = { label: 'inline', path: '', editable: false };

/**
 * MCP 客户端（stdio / HTTP / SSE）。连接具备懒重连与工具列表变更同步。
 *
 * `reload()` 是唯一的装载入口（`connect()` 是它的首次调用）：热重载与首次启动走同一条
 * 路径，两者的差异不会各自漂移——「改了配置按 r 刷新」和「冷启动」本该是同一件事。
 *
 * **启动不阻塞**：reload 对需要拉起的 server 只负责 spawn（并行、互不等待），握手在后台
 * 完成。冷启动曾实测 11.4s 全部花在串行等三台 npx server 的握手（每请求 15s 超时上限），
 * 而其余启动阶段合计不到 100ms——阻塞等待等于让最慢的外部进程决定首帧时间。
 * 握手结果进 `problems` / `connections`，并回调 `onProblem`；测试用 `whenReady()` 收口。
 */
export class McpHub {
  private readonly connections = new Map<string, Connection>();
  private readonly entries = new Map<string, Entry>();
  /** 在途握手：按名字去重（call 的懒重连不该叠出第二个子进程），whenReady 等它们落定。 */
  private readonly inFlight = new Map<string, Promise<void>>();
  private nextId = 1;
  /**
   * 宿主事实。只用到 `mergeChildEnv`：spawn 第三方 server 必须走宿主那套凭据擦除，
   * 直接传 process.env 会把 SPH_API_KEY 一类凭据送进别的进程。
   *
   * 由构造函数注入而不是 import 宿主实现——插件只从 core 引类型，运行时的宿主能力
   * 一律经 api 拿（详见 src/plugins/types.ts 的模块说明）。
   */
  private readonly host: PluginHostFacts;

  constructor(host: PluginHostFacts) {
    this.host = host;
  }

  /**
   * 异步握手失败的出口。sph-mcp 插件把它接进自己的警告容器，TUI 才能在弹窗之外
   * 也看到「server 没起来」；不设置则只记在 `problems`（`listServers()` 可见）。
   */
  onProblem: (message: string) => void = () => {};

  /** 首次装载。返回同步警告，不抛错——坏配置不该让 sph 起不来。 */
  async connect(specs: McpServerSpec[]): Promise<string[]> {
    const { warnings } = await this.reload(specs);
    return warnings;
  }

  /**
   * 装载或重载一批 server。
   *
   * 复用规则：命令签名（command + args + env）未变的连接**保持不动**。全杀重连会让正在
   * 调用工具的轮次直接失败，而热重载的典型场景恰恰是「会话跑着，我改了一个无关的 server」。
   * 已在运行中的请求也不会因此被打断。
   */
  async reload(specs: McpServerSpec[]): Promise<McpReloadResult> {
    const warnings: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    const restarted: string[] = [];
    const next = new Map<string, Entry>();

    for (const raw of specs) {
      const spec = { ...raw, enabled: raw.enabled ?? true, origin: raw.origin ?? NEUTRAL_ORIGIN };
      const blocked = blockedReason(spec);
      const signature = spawnableSignature(spec);
      const previous = this.entries.get(spec.name);
      const spawnable = blocked === undefined;

      next.set(spec.name, { spec, signature, spawnable, ...(blocked === undefined ? {} : { blocked }) });

      if (!spawnable) continue;

      if (previous?.spawnable && previous.signature === signature && this.isAlive(spec.name)) {
        continue; // 签名未变且进程还在：原样保留连接。
      }
      if (previous === undefined) added.push(spec.name);
      else restarted.push(spec.name);

      // 签名变了要先关掉旧进程，否则会留下一个再也没人调用、也不复用的孤儿。
      this.close(spec.name, 'reloading');
      // lazy 且没有存活连接时不自动拉起：进程留给首次使用（call / 带 server 的 list）。
      // 连接健康时绝不走 launch，否则热重载复用的连接会被多余 spawn 顶掉。
      if (spec.lazy === true && !this.isAlive(spec.name)) continue;
      // 只 spawn 不等待：握手互不阻塞，结果经 problems / onProblem 反馈。
      void this.launch(spec);
    }

    for (const name of this.entries.keys()) {
      if (next.has(name)) continue;
      this.close(name, 'removed from config');
      removed.push(name);
    }

    this.entries.clear();
    for (const [name, entry] of next) this.entries.set(name, entry);

    return { warnings, added, removed, restarted };
  }

  /**
   * 等所有在途握手落定（成功或失败）。测试与需要确定性时刻的调用方用；
   * `timeoutMs` 是安全阀——某台 server 卡满握手超时也不该让等待者无限挂住。
   */
  async whenReady(timeoutMs = 20_000): Promise<void> {
    const pending = () => Promise.allSettled([...this.inFlight.values()]);
    if (this.inFlight.size === 0) return;
    await Promise.race([
      (async () => {
        await pending();
        // allSettled 只反映调用瞬间的集合：等一轮后如果又有新的在途（罕见），再来一次。
        if (this.inFlight.size > 0) await pending();
      })(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  listTools(): McpTool[] {
    // 按 server + 名字排序后输出。顺序稳定性直接影响两处前缀：系统提示词里的 MCP 清单、
    // 以及 `mcp` 元工具给模型看的列表——连接 Map 的插入序随重连顺序漂移，server 自报的
    // 工具序也不保证稳定，不排序的话同一个会话可能每轮看到一份排列不同的清单。
    return Array.from(this.connections.values())
      .flatMap((conn) => conn.tools)
      .map((tool) => ({ ...tool, schema: { ...tool.schema } }))
      .sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
  }

  /**
   * 所有**已发现**的 server 及其状态与工具清单。
   *
   * 遍历 `entries` 而不是 `connections`：连不上的、被禁用的、以及 sph 跑不了的传输都必须
   * 出现——「配了却不生效」正是最需要看见的状态，只列已连接的就等于把问题藏起来。
   */
  listServers(): McpServerStatus[] {
    return Array.from(this.entries.values(), ({ spec, spawnable, blocked }) => {
      const conn = this.connections.get(spec.name);
      // connected = 握手完成（含 tools/list）且进程还活着。spawn 成功但仍在握手的算
      // connecting——「进程活着但工具还没就绪」对使用者就是还没连上。
      const connected = conn?.ready === true && conn.wire.alive();
      const lazy = spec.lazy === true;
      // 懒而未连接不是问题：它是设计好的状态，报成 problem 会在 /mcps 里看起来像故障。
      // 失败仍会进 problems，所以 lazy 只掩盖「还没轮到它启动」这一种情形。
      const problem = spawnable
        ? (connected ? undefined : this.problems.get(spec.name) ?? (lazy ? undefined : 'not connected'))
        : blocked;
      const connecting = this.inFlight.has(spec.name);
      return {
        name: spec.name,
        ...(spec.title === undefined ? {} : { title: spec.title }),
        transport: resolveTransport(spec).transport,
        supported: spawnable,
        enabled: spec.enabled,
        // 没给来源态就退化成最终态：调用方（测试、内部构造）不必为此多填一个字段。
        sourceEnabled: spec.sourceEnabled ?? spec.enabled,
        lazy,
        connected,
        ...(connecting ? { connecting: true } : {}),
        target: targetOf(spec),
        ...(problem === undefined ? {} : { problem }),
        origin: { ...spec.origin },
        tools: connected ? conn.tools.map((tool) => ({ ...tool, schema: { ...tool.schema } })) : [],
      };
    });
  }

  /**
   * spawn 并后台完成握手；同名去重（call 的懒重连不该叠出第二个子进程）。
   * 失败不抛：记 `problems`（`listServers()` 可见）并回调 `onProblem`。
   */
  private launch(spec: McpServerSpec & { enabled: boolean; origin: McpOrigin }): Promise<void> {
    const existing = this.inFlight.get(spec.name);
    if (existing) return existing;
    let task: Promise<void>;
    task = this.attach(spec)
      .then(() => {
        this.problems.delete(spec.name);
      })
      .catch((error: unknown) => {
        this.problems.set(spec.name, describeError(error));
        this.onProblem(`${spec.name}: ${describeError(error)}`);
      })
      .finally(() => {
        if (this.inFlight.get(spec.name) === task) this.inFlight.delete(spec.name);
      });
    this.inFlight.set(spec.name, task);
    return task;
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.entries.get(server);
    if (entry === undefined) throw new Error(`MCP server not connected: ${server}`);
    if (!entry.spawnable) throw new Error(`MCP server unavailable (${entry.blocked}): ${server}`);
    const conn = await this.ensureReady(server, entry);
    const result = await this.request(conn, 'tools/call', { name, arguments: args });
    return JSON.stringify(result ?? {});
  }

  /**
   * 定向列表：保证该 server 已连接后返回它的工具清单。
   *
   * lazy server 的首连入口——模型需要参数 schema 才能调用工具，所以「看列表」必须连带
   * 连接；而全局 `listTools()` 保持只读，模型遍历目录时不会把没碰过的 server 全拉起来。
   */
  async listToolsOf(server: string): Promise<McpTool[]> {
    const entry = this.entries.get(server);
    if (entry === undefined) throw new Error(`MCP server not configured: ${server}`);
    if (!entry.spawnable) throw new Error(`MCP server unavailable (${entry.blocked}): ${server}`);
    const conn = await this.ensureReady(server, entry);
    return conn.tools.map((tool) => ({ ...tool, schema: { ...tool.schema } }));
  }

  /** 连接就绪保障：未就绪时拉起并等握手（按名字去重），仍不可用按原因抛。 */
  private async ensureReady(server: string, entry: Entry): Promise<Connection> {
    let conn = this.connections.get(server);
    if (conn === undefined || !conn.ready || !conn.wire.alive()) {
      // 未就绪才拉起：launch 按名字去重——在途握手就等它，落定后仍不可用按原因抛。
      // 连接健康时绝不走到这里，否则热重载复用的连接会被多余 spawn 顶掉。
      await this.launch(entry.spec);
      conn = this.connections.get(server);
      if (conn === undefined || !conn.ready || !conn.wire.alive()) {
        throw new Error(this.problems.get(server) ?? `MCP server not connected: ${server}`);
      }
    }
    return conn;
  }

  dispose(): void {
    for (const [name, conn] of this.connections) {
      this.failPending(conn, `MCP server ${name} disposed`);
      conn.wire.close();
    }
    this.connections.clear();
    this.entries.clear();
    this.problems.clear();
  }

  /** 启用却连不上/未连接的原因，按名字记；attach 成功时清掉。 */
  private readonly problems = new Map<string, string>();

  private isAlive(name: string): boolean {
    const conn = this.connections.get(name);
    return conn !== undefined && conn.wire.alive();
  }

  private close(name: string, reason: string): void {
    this.inFlight.delete(name);
    const conn = this.connections.get(name);
    if (conn === undefined) return;
    this.failPending(conn, `MCP server ${name} ${reason}`);
    conn.wire.close();
    this.connections.delete(name);
  }

  private async attach(spec: McpServerSpec & { enabled: boolean; origin: McpOrigin }): Promise<Connection> {
    const { transport } = resolveTransport(spec);
    if (transport === 'http' || transport === 'sse') return this.attachRemote(spec, transport);
    return this.attachStdio(spec);
  }

  private async attachRemote(
    spec: McpServerSpec & { enabled: boolean; origin: McpOrigin },
    transport: 'http' | 'sse',
  ): Promise<Connection> {
    let link: RemoteLink | undefined;
    const conn: Connection = {
      wire: {
        write: (message) => link?.write(message),
        close: () => link?.close(),
        alive: () => link?.alive() ?? false,
      },
      ready: false,
      tools: [],
      pending: new Map(),
      buffer: '',
    };
    const options = {
      url: spec.url ?? '',
      headers: spec.headers,
      onMessage: (message: JsonRpcMessage) => this.onRpc(conn, spec.name, message as JsonRpc),
      onRequestError: (id: number | undefined, error: Error) => this.rejectId(conn, id, error),
      onClose: (reason: string) => {
        this.problems.set(spec.name, reason);
        this.failPending(conn, `MCP server ${spec.name} ${reason}`);
      },
    };
    link = transport === 'sse' ? openSseLink(options) : openHttpLink(options);
    this.connections.set(spec.name, conn);
    try {
      await link.open();
      await this.request(conn, 'initialize', {
        protocolVersion: transport === 'sse' ? '2024-11-05' : '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'sph', version: '0.1.0' },
      });
      conn.wire.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.refreshTools(spec.name, conn);
      conn.ready = true;
    } catch (error) {
      link.close();
      this.connections.delete(spec.name);
      this.problems.set(spec.name, describeError(error));
      throw error;
    }
    this.problems.delete(spec.name);
    return conn;
  }

  private async attachStdio(spec: McpServerSpec & { enabled: boolean; origin: McpOrigin }): Promise<Connection> {
    // Windows：裸命令名按 PATH × PATHEXT 解析（CreateProcess 只补 .exe，npx 这类
    // 批处理启动器会 ENOENT）；解析到 .cmd/.bat 再经 cmd.exe 启动（Node 因
    // CVE-2024-27980 拒绝直接 spawn 批处理）。见 win-command.ts。
    let launchCommand = spec.command ?? '';
    let launchArgs: readonly string[] = spec.args ?? [];
    const spawnOptions: Parameters<typeof spawn>[2] = {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 擦除 KEY/TOKEN/SPH_* 后再叠 spec.env：MCP 自己的密钥可以显式转交，宿主的不行。
      env: this.host.mergeChildEnv(spec.env),
    };
    if (process.platform === 'win32') {
      const resolved = resolveWindowsCommand(launchCommand);
      if (resolved?.viaCmd) {
        // 数组 + verbatim：Node 原样拼接 lpCommandLine。整串塞进 command 会被当成
        // 文件名去找（实测 ENOENT），必须走这里。
        spawnOptions.windowsVerbatimArguments = true;
        // 裸 cmd.exe 会先搜工作区 cwd；固定 System32，避免仓库里放一个 cmd.exe 劫持 MCP。
        const root = process.env.SystemRoot ?? 'C:\\Windows';
        launchCommand = join(root, 'System32', 'cmd.exe');
        launchArgs = ['/d', '/s', '/c', cmdArgumentLine(resolved.file, launchArgs)];
      } else if (resolved) {
        launchCommand = resolved.file;
      }
    }
    // stdio 三端都是 pipe，stdout/stdin 不会是 null。类型上 spawn 仍标成可空。
    const child = spawn(launchCommand, launchArgs as string[], spawnOptions) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding('utf8');
    let dead = false;
    const conn: Connection = {
      pid: child.pid,
      wire: {
        write: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
        close: () => {
          dead = true;
          stopStdioChild(child);
        },
        alive: () => !dead && child.exitCode === null && child.pid !== undefined,
      },
      ready: false,
      tools: [],
      pending: new Map(),
      buffer: '',
    };
    child.stdout.on('data', (chunk: string) => this.onData(conn, spec.name, chunk));
    // destroy() 在对端已断时会抛 error。没人听就会变成未捕获异常。
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('exit', () => {
      dead = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        this.problems.set(spec.name, `exited (code ${child.exitCode ?? child.signalCode})`);
      }
      this.failPending(conn, `MCP server ${spec.name} exited`);
    });
    // spawn 失败（命令不存在、不在 PATH）走 'error' 事件而不是让 spawn 抛错。**必须有监听器**：
    // EventEmitter 在没有 'error' 监听时会把事件升级成未捕获异常，直接干掉整个进程——而
    // 「配置里把命令名写错/该命令没装」正是这个文件最常见的配置事故，它该变成一条警告
    // （connect 的返回值、TUI 的 mcpWarnings 通道都为此准备着），不该让 sph 起不来。
    child.on('error', (error: Error) => {
      dead = true;
      this.problems.set(spec.name, `failed to start: ${error.message}`);
      this.failPending(conn, `MCP server ${spec.name} failed to start: ${error.message}`);
    });
    // stdin 写失败（子进程已死 → EPIPE）会以 'error' 事件抛出：不接住就是未捕获异常，
    // 整个进程会因此崩掉，而这里只是「一次调用失败」。
    child.stdin.on('error', () => this.failPending(conn, `MCP server ${spec.name} stdin is closed`));
    this.connections.set(spec.name, conn);
    try {
      await this.request(conn, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sph', version: '0.1.0' },
      });
      conn.wire.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.refreshTools(spec.name, conn);
      conn.ready = true;
    } catch (error) {
      conn.wire.close();
      this.connections.delete(spec.name);
      this.problems.set(spec.name, describeError(error));
      throw error;
    }
    this.problems.delete(spec.name);
    return conn;
  }

  private async refreshTools(serverName: string, conn: Connection): Promise<void> {
    const listed = await this.request(conn, 'tools/list', {}) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    } | undefined;
    conn.tools = (listed?.tools ?? []).map((tool) => ({
      server: serverName,
      name: tool.name,
      description: tool.description ?? '',
      schema: deepSortKeys(tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }));
  }

  /** 连接断开时把所有在途请求一次性失败，避免调用方挂到 15s 超时。 */
  private failPending(conn: Connection, message: string): void {
    for (const entry of conn.pending.values()) entry.reject(new Error(message));
    conn.pending.clear();
    conn.buffer = '';
  }

  private onData(conn: Connection, name: string, chunk: string): void {
    const lines = (conn.buffer + chunk).split('\n');
    conn.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpc;
      try {
        msg = JSON.parse(trimmed) as JsonRpc;
      } catch {
        continue;
      }
      this.onRpc(conn, name, msg);
    }
  }

  private onRpc(conn: Connection, name: string, msg: JsonRpc): void {
    if (msg.id !== undefined) {
      const entry = conn.pending.get(msg.id);
      if (entry) {
        conn.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? 'MCP error'));
        else entry.resolve(msg.result);
        return;
      }
    }
    if (msg.method === 'notifications/tools/list_changed') {
      void this.refreshTools(name, conn).catch(() => {
        // 变更同步失败保持旧列表；下次 call 的懒重连会兜底。
      });
    }
  }

  private rejectId(conn: Connection, id: number | undefined, error: Error): void {
    if (id === undefined) return;
    const entry = conn.pending.get(id);
    if (entry === undefined) return;
    conn.pending.delete(id);
    entry.reject(error);
  }

  private request(conn: Connection, method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 15_000);
      conn.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      conn.wire.write({ jsonrpc: '2.0', id, method, params });
    });
  }
}

/** 疑似密钥的字段名。只在**字段名**上判定，不去猜值长什么样。 */
const SECRET_NAME = /(key|token|secret|password|passwd|credential)/i;

/**
 * 展示用目标：stdio 是命令行（带空格的参数加引号），http 是 URL。
 *
 * 疑似密钥的值一律打码。这些值来自用户自己的配置文件，而把 API key 直接写进 `args`
 * 是常见写法（`--api-key sk-...`）；`/mcps` 会把启动命令打到屏幕上，屏幕内容又经常被
 * 截图或贴进 issue——原样显示是不必要的暴露，而这个字符串本来就只是给人看的。
 */
function targetOf(spec: McpServerSpec): string {
  if (spec.url !== undefined) return redactUrl(spec.url);
  // 不先 filter：过滤会打乱下标，而「上一个参数是不是 --api-key」正是靠下标判断的。
  const parts = [spec.command ?? '', ...(spec.args ?? [])];
  return parts
    .map((part, index) => {
      const previous = index > 0 ? parts[index - 1] : undefined;
      // 只看**以 `-` 开头的旗帜**：`GITHUB_TOKEN=x` 这种赋值本身就是敏感项，但它不该
      // 顺带把它后面那个普通参数也打成星号。
      const afterFlag =
        previous?.startsWith('-') === true && SECRET_NAME.test(previous);
      return quoteArg(afterFlag || hasSecretAssignment(part) ? redactArg(part) : part);
    })
    .filter((part) => part !== '')
    .join(' ');
}

function quoteArg(part: string): string {
  if (part === '') return '';
  return /\s/.test(part) ? `"${part}"` : part;
}

/** `KEY=value` 形态（env 风格）：按等号左边的名字判定，不去猜值的样子。 */
function hasSecretAssignment(value: string): boolean {
  const eq = /^([A-Za-z0-9_]+)=/.exec(value);
  return eq !== null && SECRET_NAME.test(eq[1]!);
}

function redactArg(value: string): string {
  const eq = /^([A-Za-z0-9_]+)=/.exec(value);
  return eq === null ? '***' : `${eq[1]}=***`;
}

function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.username !== '' || url.password !== '') {
    url.username = '***';
    url.password = '***';
  }
  // 查询串里带 token 的地址很常见（`?api_key=...`）。改的是副本，不影响 spawn。
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_NAME.test(name)) url.searchParams.set(name, '***');
  }
  return url.toString();
}

/** 不能拉起的原因；undefined 表示这个传输可以连。 */
function blockedReason(spec: McpServerSpec & { enabled: boolean }): string | undefined {
  if (!spec.enabled) return 'disabled';
  const resolved = resolveTransport(spec);
  if (resolved.invalid !== undefined) return `unknown transport: ${resolved.invalid}`;
  if (resolved.transport === 'http' || resolved.transport === 'sse') {
    if (spec.url === undefined || spec.url === '') return 'no url given';
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      return 'url is not a valid URL';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'url must be http or https';
    return undefined;
  }
  if (spec.command === undefined || spec.command === '') return 'no command given';
  return undefined;
}

/** 决定连接能否复用的签名：传输、命令、url、头和环境都算。 */
function spawnableSignature(spec: McpServerSpec): string {
  const joined = (record: Record<string, string> | undefined) => Object.entries(record ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\u0000');
  return [
    resolveTransport(spec).transport,
    spec.command ?? '',
    ...(spec.args ?? []),
    '\u0001',
    spec.url ?? '',
    '\u0001',
    joined(spec.headers),
    '\u0001',
    joined(spec.env),
  ].join('\u0000');
}

/**
 * 递归按键名排序（数组保持元素序）。
 *
 * MCP server 自报的 `inputSchema` 的 key 序不保证稳定：同一次会话里 server 重连后
 * 重发的 schema 可能只是 key 排列不同，序列化进请求却成了逐字节不同的前缀——tools
 * 段变更（见 agent/prefix-tracker.ts）会作废其后全部缓存。存储前规范化一次，序列化
 * 从此与 server 的任意抖动解耦。语义等价：JSON 对象本就是无序集合，排序只改呈现。
 */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = deepSortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}
