import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export interface McpTool {
  server: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

type TaggedChild = ChildProcessWithoutNullStreams & { sphName: string };

interface Connection {
  child: TaggedChild;
  tools: McpTool[];
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  /** 未收全的行：stdout 的 chunk 边界与 JSON-RPC 行边界无关，半行必须留到下一块再拼。 */
  buffer: string;
}

/** 只接 stdio MCP；HTTP 传输按设计排除。连接具备懒重连与工具列表变更同步。 */
export class McpHub {
  private readonly connections = new Map<string, Connection>();
  private nextId = 1;

  async connect(servers: McpServerConfig[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const server of servers) {
      try {
        await this.attach(server);
      } catch (error) {
        warnings.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return warnings;
  }

  listTools(): McpTool[] {
    return Array.from(this.connections.values())
      .flatMap((conn) => conn.tools)
      .map((tool) => ({ ...tool, schema: { ...tool.schema } }));
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<string> {
    let conn = this.connections.get(server);
    if (!conn) throw new Error(`MCP server not connected: ${server}`);
    if (conn.child.exitCode !== null || !conn.child.pid) {
      // 懒重连：server 崩溃后首次调用时重新拉起，不给交互增加后台监督开销。
      const config = this.configs.get(server);
      if (!config) throw new Error(`MCP server not reconnectable: ${server}`);
      conn = await this.attach(config);
    }
    const result = await this.request(conn, 'tools/call', { name, arguments: args });
    return JSON.stringify(result ?? {});
  }

  dispose(): void {
    for (const [name, conn] of this.connections) {
      this.failPending(conn, `MCP server ${name} disposed`);
      conn.child.kill();
    }
    this.connections.clear();
    this.configs.clear();
  }

  private readonly configs = new Map<string, McpServerConfig>();

  private async attach(server: McpServerConfig): Promise<Connection> {
    const child = spawn(server.command, server.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as TaggedChild;
    child.sphName = server.name;
    child.stdout.setEncoding('utf8');
    const conn: Connection = { child, tools: [], pending: new Map(), buffer: '' };
    child.stdout.on('data', (chunk: string) => this.onData(conn, chunk));
    child.on('exit', () => this.failPending(conn, `MCP server ${server.name} exited`));
    // stdin 写失败（子进程已死 → EPIPE）会以 'error' 事件抛出：不接住就是未捕获异常，
    // 整个进程会因此崩掉，而这里只是「一次调用失败」。
    child.stdin.on('error', () => this.failPending(conn, `MCP server ${server.name} stdin is closed`));
    this.connections.set(server.name, conn);
    this.configs.set(server.name, server);
    try {
      await this.request(conn, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sph', version: '0.1.0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      await this.refreshTools(server.name, conn);
    } catch (error) {
      child.kill();
      this.connections.delete(server.name);
      throw error;
    }
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
      schema: tool.inputSchema ?? { type: 'object' },
    }));
  }

  /** 连接断开时把所有在途请求一次性失败，避免调用方挂到 15s 超时。 */
  private failPending(conn: Connection, message: string): void {
    for (const entry of conn.pending.values()) entry.reject(new Error(message));
    conn.pending.clear();
    conn.buffer = '';
  }

  private onData(conn: Connection, chunk: string): void {
    // 先拼上上次残留的半行，再把最后一段不完整的行留回缓冲。
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
      if (msg.id !== undefined && conn.pending.has(msg.id)) {
        const entry = conn.pending.get(msg.id)!;
        conn.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? 'MCP error'));
        else entry.resolve(msg.result);
        continue;
      }
      if (msg.method === 'notifications/tools/list_changed') {
        const name = conn.child.sphName;
        void this.refreshTools(name, conn).catch(() => {
          // 变更同步失败保持旧列表；下次 call 的懒重连会兜底。
        });
      }
    }
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
      conn.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}
