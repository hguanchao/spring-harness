import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { McpHub } from '../../src/plugins/sph-mcp/hub.js';
import { consumeSse, postTimeoutMs } from '../../src/plugins/sph-mcp/remote.js';
import { testHostFacts } from '../plugins/host-fixture.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve(address.port);
    });
  });
}

describe('SSE 帧', () => {
  it('postTimeoutMs 只对 tools/call 放宽', () => {
    assert.equal(postTimeoutMs('tools/call', 15_000, 120_000), 120_000);
    assert.equal(postTimeoutMs('tools/list', 15_000, 120_000), 15_000, '控制请求不吃 call 超时');
    assert.equal(postTimeoutMs('tools/call', 15_000, undefined), 15_000, '未配置回退默认');
    assert.equal(postTimeoutMs('tools/call', 15_000, 0), 15_000, '非法值回退默认');
  });

  it('空行结束一帧，半帧留在缓冲里', () => {
    const first = consumeSse('event: endpoint\ndata: /message\n\nevent: message\ndata: {"id":1');
    assert.deepEqual(first.frames, [{ event: 'endpoint', data: '/message' }]);
    const rest = consumeSse(`${first.rest}}\n\n`);
    assert.equal(rest.frames[0]?.data, '{"id":1}');
  });
});

describe('远程 MCP', () => {
  it('可流式 HTTP：会话号带回后续请求，工具调用能回来', async () => {
    let sawSession = false;
    let sawAgent = false;
    const server = createServer((req, res) => {
      if (req.headers['user-agent'] === 'sph/0.1.0') sawAgent = true;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
        if (message.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (message.method === 'initialize') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-1',
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't', version: '1' } },
          }));
          return;
        }
        if (req.headers['mcp-session-id'] !== 'sess-1') {
          res.writeHead(400);
          res.end('missing session');
          return;
        }
        sawSession = true;
        const result = message.method === 'tools/list'
          ? { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'pong' }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    const port = await listen(server);
    const hub = new McpHub(testHostFacts());
    try {
      await hub.reload([{ name: 'remote', url: `http://127.0.0.1:${port}/mcp`, transport: 'http' }]);
      await hub.whenReady();
      const status = hub.listServers()[0];
      assert.equal(status?.transport, 'http');
      assert.equal(status?.connected, true, status?.problem);
      assert.equal(await hub.call('remote', 'ping', {}), JSON.stringify({ content: [{ type: 'text', text: 'pong' }] }));
      assert.equal(sawSession, true);
      assert.equal(sawAgent, true);
    } finally {
      hub.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('远程 tools/call 受 callTimeoutMs 约束：HTTP 层不会先掐死放宽后的上限', async () => {
    // 回归点：远程每条 POST 自带 AbortSignal 超时。hub 放宽到 60s 而这里仍是 15s 的话，
    // call_timeout_ms 对 http/sse 传输形同虚设。
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
        if (message.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (message.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't', version: '1' } },
          }));
          return;
        }
        const respond = (): void => {
          const result = message.method === 'tools/list'
            ? { tools: [{ name: 'slow', description: 'p', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'late' }] };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        };
        if (message.method === 'tools/call') {
          setTimeout(respond, 500);
          return;
        }
        respond();
      });
    });
    const port = await listen(server);
    const hub = new McpHub(testHostFacts());
    try {
      await hub.reload([{
        name: 'remote',
        url: `http://127.0.0.1:${port}/mcp`,
        transport: 'http',
        callTimeoutMs: 200,
      }]);
      await hub.whenReady();
      await assert.rejects(() => hub.call('remote', 'slow', {}), /MCP timeout: tools\/call/);
    } finally {
      hub.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('旧 SSE：先拿 endpoint，应答从事件流回来', async () => {
    let events: import('node:http').ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /message\n\n');
        events = res;
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
        res.writeHead(202);
        res.end();
        if (message.id === undefined || events === undefined) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'sse-pong' }] };
        events.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
      });
    });
    const port = await listen(server);
    const hub = new McpHub(testHostFacts());
    try {
      await hub.reload([{ name: 'legacy', url: `http://127.0.0.1:${port}/sse` }]);
      await hub.whenReady();
      const status = hub.listServers()[0];
      assert.equal(status?.transport, 'sse', status?.problem);
      assert.equal(status?.connected, true, status?.problem);
      assert.equal(await hub.call('legacy', 'ping', {}), JSON.stringify({ content: [{ type: 'text', text: 'sse-pong' }] }));
    } finally {
      hub.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
