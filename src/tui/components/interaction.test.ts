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

function statusLines(indicator: WorkingStatusIndicator, width: number): { raw: string; plain: string } {
  const lines = indicator.render(width);
  assert.equal(lines.length, 2);
  const raw = lines[1] ?? '';
  return { raw, plain: stripTerminalSequences(raw) };
}

describe('WorkingStatusIndicator elapsed', () => {
  it('耗时用 CHA 落到右侧，整行不铺空格', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      const width = 40;
      const { raw, plain } = statusLines(indicator, width);
      assert.match(plain, /Working…/);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
      const duration = plain.trimEnd().match(/(\d+\.\ds)$/)?.[1] ?? '';
      assert.match(raw, new RegExp(`\\x1b\\[${width - 4 - duration.length + 1}G`));
      assert.equal(/\s{4,}/.test(plain.trim()), false, '中间不应铺空格');
      assert.ok(visibleWidth(plain) < width, '可见宽度应小于终端宽，留给 2K 填底');
    } finally {
      indicator.dispose();
    }
  });

  it('切换阶段文案后耗时仍在右侧', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      indicator.setMessage(WorkingLabel.thinking);
      const { raw, plain } = statusLines(indicator, 40);
      assert.match(plain, /Thinking…/);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
      assert.match(raw, /\x1b\[\d+G/);
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
      const { plain } = statusLines(indicator, 120);
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
      const { plain } = statusLines(indicator, 48);
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
      const { plain } = statusLines(indicator, 12);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
    } finally {
      indicator.dispose();
    }
  });
});
