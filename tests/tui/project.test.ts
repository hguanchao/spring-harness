import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectEvent } from '../../src/plugins/sph-tui/project.js';
import type { AgentEvent } from '../../src/agent/events.js';

describe('回合事件投影', () => {
  it('工具结束和子代理结束各变成一行', () => {
    const tool: AgentEvent = { type: 'tool_end', name: 'read', id: 'c1', ok: true, content: 'src/cli/index.ts\nmore' };
    assert.deepEqual(projectEvent(tool), { kind: 'tool', text: 'Read: src/cli/index.ts more' });
    const failed: AgentEvent = { type: 'tool_end', name: 'bash', id: 'c2', ok: false, content: 'exit 1' };
    assert.equal(projectEvent(failed)?.text.startsWith('Bash failed'), true);
    const child: AgentEvent = {
      type: 'subagent_end',
      id: 's1',
      ok: false,
      durationMs: 1,
      summary: 'Stopped at the limit',
      tokens: 0,
    };
    assert.deepEqual(projectEvent(child), { kind: 'subagent', text: 'Task failed: Stopped at the limit' });
  });

  it('用量和思考不进转录', () => {
    assert.equal(projectEvent({ type: 'usage', promptTokens: 1, completionTokens: 1 }), undefined);
    assert.equal(projectEvent({ type: 'thinking_start', id: 't' }), undefined);
  });
});
