// 测试用的最小 MCP server。
//
// 存在的理由：hub 的连接复用/重启行为只有对着**真的子进程**才测得准。用桩替掉
// spawn 就只能断言「我调用了几次 attach」，而真正要保证的是「热重载没有把正在用的
// 工具抖掉」——那等价于「子进程 pid 没变」。所以 tools/call 的回包里带上 pid。
//
// 只实现握手所需的最小面：initialize / tools/list / tools/call。

import { createInterface } from 'node:readline';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  // 通知（无 id）不需要应答。
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sph-test-fixture', version: '1.0.0' },
        },
      });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'ping',
              description: 'returns the serving process pid',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: 'slow',
              description: 'responds after arguments.ms milliseconds',
              inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
            },
          ],
        },
      });
      return;
    case 'tools/call':
      // slow 工具按参数延迟应答：tools/call 超时只有对着真会拖的子进程才测得准。
      if (message.params?.name === 'slow') {
        const ms = Number(message.params?.arguments?.ms ?? 0);
        setTimeout(() => {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: `waited=${ms}` }],
            },
          });
        }, ms);
        return;
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              // argv 也报回去：展示层会对疑似密钥打码，而这里必须收到**原值**——
              // 否则就是「屏幕上看不到，子进程也拿不到」。
              text: `pid=${process.pid} label=${process.env.SPH_TEST_LABEL ?? ''} argv=${process.argv.slice(2).join(',')}`,
            },
          ],
        },
      });
      return;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { message: `unknown method: ${message.method}` } });
  }
});
rl.on('close', () => process.exit(0));
