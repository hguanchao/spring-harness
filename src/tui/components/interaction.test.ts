import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../core/index.js';
import { stripTerminalSequences, visibleWidth } from '../core/index.js';
import { formatWorkingWarning, WorkingLabel, WorkingStatusIndicator, workingWarningKey } from './interaction.js';

const ui = {
  requestRender: () => {
    // Loader 动画会打这个钩子；测试只关心渲染结果。
  },
} as unknown as TUI;

function statusLine(indicator: WorkingStatusIndicator, width: number): string {
  const lines = indicator.render(width);
  assert.equal(lines.length, 2);
  return stripTerminalSequences(lines[1] ?? '');
}

describe('WorkingStatusIndicator elapsed', () => {
  it('耗时在右侧但离开滚动条列（末尾 4 列空白）', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      const width = 40;
      const plain = statusLine(indicator, width);
      assert.equal(visibleWidth(plain), width);
      assert.match(plain, /Working…/);
      const trimmed = plain.trimEnd();
      assert.match(trimmed, /\d+\.\ds$/);
      const duration = trimmed.match(/(\d+\.\ds)$/)?.[1] ?? '';
      assert.equal(plain.endsWith(' '.repeat(4)), true);
      assert.equal(trimmed.endsWith(duration), true);
      assert.equal(plain.indexOf(duration), width - duration.length - 4);
    } finally {
      indicator.dispose();
    }
  });

  it('切换阶段文案后耗时仍离开滚动条列', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      indicator.setMessage(WorkingLabel.thinking);
      const plain = statusLine(indicator, 40);
      assert.match(plain, /Thinking…/);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
      assert.equal(plain.endsWith(' '.repeat(4)), true);
    } finally {
      indicator.dispose();
    }
  });

  it('警告叠在状态行上：同一条文案累计次数，Retrying 前缀不进展示', () => {
    assert.equal(
      formatWorkingWarning('Stream ended without a finish reason (none) — continuing the turn.', 1),
      'Stream ended without a finish reason (none) — continuing the turn. (1)',
    );
    assert.equal(
      workingWarningKey('Retrying LLM stream (attempt 2): LLM stream idle timeout (30000ms)'),
      'LLM stream idle timeout (30000ms)',
    );
    assert.equal(
      formatWorkingWarning('Retrying LLM stream (attempt 2): LLM stream idle timeout (30000ms)', 3),
      'LLM stream idle timeout (30000ms) (3)',
    );
    assert.equal(
      formatWorkingWarning(
        'Retrying LLM stream (attempt 3): LLM HTTP 400: unsupported prompt_cache_key; dropping extra request fields',
        1,
      ),
      'LLM HTTP 400: unsupported prompt_cache_key; dropping extra request fields (1)',
    );

    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.thinking);
    try {
      indicator.setMessage(formatWorkingWarning('Stream ended without a finish reason (none) — continuing the turn.', 2));
      const plain = statusLine(indicator, 120);
      assert.match(plain, /Stream ended without a finish reason \(none\) — continuing the turn\. \(2\)/);
      assert.equal(plain.includes('Thinking'), false);
    } finally {
      indicator.dispose();
    }
  });

  it('窄宽度时省略警告正文，次数与耗时仍完整', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.thinking);
    try {
      indicator.setMessage(
        formatWorkingWarning(
          'LLM HTTP 400: {"message":"Validation: Unsupported parameter(s): `prompt_cache_key`","type":"Bad Request"}; dropping extra request fields',
          12,
        ),
      );
      const plain = statusLine(indicator, 48);
      assert.match(plain, /\(12\)/, '次数不能被省略号吃掉');
      assert.equal(/\(\d+…/.test(plain), false, '不能裁成 (1…');
      assert.match(plain.trimEnd(), /\d+\.\ds$/, '耗时仍在右侧');
      assert.ok(plain.includes('…'), '正文超出时应省略');
    } finally {
      indicator.dispose();
    }
  });

  it('窄宽度时仍保留右侧耗时', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.running('Bash'));
    try {
      const plain = statusLine(indicator, 12);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
    } finally {
      indicator.dispose();
    }
  });
});
