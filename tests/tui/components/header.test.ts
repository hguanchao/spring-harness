import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HeaderComponent, type HeaderData } from '../../../src/plugins/sph-tui/components/header.js';
import { stripTerminalSequences } from '../../../src/tui/utils.js';

function data(extra: Partial<HeaderData> = {}): HeaderData {
  return {
    version: '0.1.0',
    workspaceRoot: 'E:/demo',
    sessionId: 'abc',
    provider: 'fengwind',
    model: 'deepseek-v4.1-flash',
    effort: 'high',
    approvalMode: 'ask',
    sandboxMode: 'workspace',
    mcpServerCount: 3,
    skillCount: 6,
    ...extra,
  };
}

function plain(lines: string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).join('\n');
}

describe('顶部欢迎头', () => {
  it('模型行是供应商 · 模型 · effort，runtime 末尾有 skill 数量', () => {
    const text = plain(new HeaderComponent({ get: () => data() }).render(120));
    assert.match(text, /model\s+fengwind · deepseek-v4\.1-flash · high/);
    assert.match(text, /runtime\s+approval ask · sandbox workspace · mcp 3 · skill 6/);
  });

  it('commands 提示用 Shift+Tab，不出现 Ctrl+C', () => {
    const text = plain(new HeaderComponent({ get: () => data() }).render(160));
    assert.match(text, /Shift\+Tab approval/);
    assert.equal(text.includes('Ctrl+C'), false);
  });
});
