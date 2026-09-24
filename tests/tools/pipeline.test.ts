import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolDenied } from '../../src/tools/pipeline.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolSpec } from '../../src/tools/types.js';

const execute: ToolSpec['execute'] = async () => ({ ok: true, content: '' });

function registry(): ToolRegistry {
  return new ToolRegistry([
    { name: 'read', description: 'read', schema: {}, execute, concurrencySafe: true, planSafe: true },
    { name: 'write', description: 'write', schema: {}, execute },
    { name: 'task', description: 'task', schema: {}, execute, rootOnly: true },
  ]);
}

describe('工具执行判定', () => {
  it('未知工具、越权工具、计划模式里的写工具都被拒绝', () => {
    const tools = registry();
    assert.match(toolDenied(tools, 'missing', {}, { depth: 0 }) ?? '', /unknown tool/);
    assert.match(toolDenied(tools, 'task', {}, { depth: 1 }) ?? '', /root session/);
    assert.match(toolDenied(tools, 'write', {}, { depth: 0, planMode: true }) ?? '', /plan mode/);
    assert.equal(toolDenied(tools, 'read', {}, { depth: 0, planMode: true }), undefined);
  });

  it('能力集没给的工具拒绝，计划模式可以按参数放行', () => {
    const tools = registry();
    assert.match(
      toolDenied(tools, 'write', {}, { depth: 0, allowed: new Set(['read']) }) ?? '',
      /not allowed/,
    );
    assert.equal(
      toolDenied(tools, 'write', { agent: 'explore' }, {
        depth: 0,
        planMode: true,
        plan: { isBlocked: () => false, blockedReason: () => 'no', promptSection: () => '', hasPlanHeading: () => false, planHeading: () => undefined, planFilePath: () => '' },
      }),
      undefined,
    );
  });
});
