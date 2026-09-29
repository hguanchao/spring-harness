import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HeaderComponent, type HeaderData } from '@/plugins/sph-tui/header/index.js';
import { stripTerminalSequences } from '@/tui/text/utils.js';

function data(extra: Partial<HeaderData> = {}): HeaderData {
  return {
    version: '0.1.0',
    workspaceRoot: 'E:/demo',
    sessionId: 'abc',
    provider: 'fengwind',
    model: 'GLM 5.3 Flash',
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
  it('左边是产品名和版本，右边同一屏放 workspace / session / model / runtime', () => {
    const text = plain(new HeaderComponent({ get: () => data() }).render(120));
    const rows = text.split('\n').map((line) => line.trimEnd());
    const title = rows.find((line) => line.includes('Spring Harness'));
    const version = rows.find((line) => line.includes('sph v0.1.0'));
    const workspace = rows.find((line) => line.includes('workspace'));
    const session = rows.find((line) => /\bsession\b/.test(line));
    const model = rows.find((line) => /\bmodel\b/.test(line));
    assert.ok(title);
    assert.ok(version);
    assert.ok(workspace);
    assert.ok(session);
    assert.ok(model);
    assert.equal(workspace.includes('Spring Harness'), false, '产品名相对四行信息垂直居中，不跟 workspace 同行');
    assert.match(session, /Spring Harness/);
    assert.match(model, /sph v0\.1\.0/);
    assert.match(text, /session\s+abc/);
    assert.match(text, /model\s+fengwind · GLM 5\.3 Flash · high/);
    assert.match(text, /runtime\s+approval ask · sandbox workspace · mcp 3 · skill 6/);
    assert.equal(text.includes('personal agent runtime'), false);
    assert.equal(text.includes('/help'), false);
    assert.equal(text.includes('/permission'), false);
  });

  it('commands 提示用 Shift+Tab，不出现 Ctrl+C', () => {
    const text = plain(new HeaderComponent({ get: () => data() }).render(160));
    assert.match(text, /Shift\+Tab approval/);
    assert.equal(text.includes('Ctrl+C'), false);
  });
});
