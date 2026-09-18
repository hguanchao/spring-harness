import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../core/index.js';
import { stripTerminalSequences, visibleWidth } from '../core/index.js';
import { formatStatusElapsed, formatStatusTokens } from '../../util.js';
import { formatWorkingWarning, IdleStatus, WorkingLabel, WorkingStatusIndicator, workingWarningKey } from './interaction.js';

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

describe('status elapsed / tokens', () => {
  it('10s 以内留一位小数，之上取整，小时走 h', () => {
    assert.equal(formatStatusElapsed(500), '0.5s');
    assert.equal(formatStatusElapsed(2900), '2.9s');
    assert.equal(formatStatusElapsed(10_000), '10s');
    assert.equal(formatStatusElapsed(17_000), '17s');
    assert.equal(formatStatusElapsed(80_000), '1m20s');
    assert.equal(formatStatusElapsed(3_725_000), '1h2m');
  });

  it('token 缩写跟在本轮耗时后面用的那套', () => {
    assert.equal(formatStatusTokens(12), '12');
    assert.equal(formatStatusTokens(1470), '1.47k');
    assert.equal(formatStatusTokens(10_100), '10.1k');
    assert.equal(formatStatusTokens(147_000), '147k');
    assert.equal(formatStatusTokens(1_470_000), '1.47m');
  });
});

describe('WorkingStatusIndicator elapsed', () => {
  it('耗时用 CHA 落到右侧，整行不铺空格', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      const width = 40;
      const { raw, plain } = statusLines(indicator, width);
      assert.match(plain, /Calling model…/);
      assert.match(plain, /Calling model… \d+\.\ds/);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
      const duration = plain.trimEnd().match(/(\d+\.\ds)$/)?.[1] ?? '';
      assert.match(raw, new RegExp(`\\x1b\\[${width - 4 - duration.length + 1}G`));
      assert.equal(/\s{4,}/.test(plain.trim()), false, '中间不应铺空格');
      assert.ok(visibleWidth(plain) < width, '可见宽度应小于终端宽，留给 2K 填底');
    } finally {
      indicator.dispose();
    }
  });

  it('切换阶段文案后本轮耗时仍在右侧，文案后跟阶段耗时', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      indicator.setMessage(WorkingLabel.thinking);
      const { raw, plain } = statusLines(indicator, 40);
      assert.match(plain, /Thinking… \d+\.\ds/);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
      assert.match(raw, /\x1b\[\d+G/);
    } finally {
      indicator.dispose();
    }
  });

  it('有 token 时跟在本轮耗时后面', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      indicator.setTokens(1470);
      const { plain } = statusLines(indicator, 80);
      assert.match(plain.trimEnd(), /\d+\.\ds ↓1\.47k$/);
    } finally {
      indicator.dispose();
    }
  });

  it('警告叠在状态行上：重试走 headline · retry N，其它警告重复才加次数', () => {
    assert.equal(
      formatWorkingWarning('Stream ended without a finish reason (none) — continuing the turn.', 1),
      'No finish reason',
    );
    assert.equal(
      formatWorkingWarning('Stream ended without a finish reason (none) — continuing the turn.', 2),
      'No finish reason (2)',
    );
    assert.equal(
      workingWarningKey('Retrying LLM stream (attempt 2): LLM stream idle timeout (30000ms)'),
      'Stream stalled',
    );
    assert.equal(
      formatWorkingWarning('Retrying LLM stream (attempt 2): LLM stream idle timeout (30000ms)', 3),
      'Stream stalled · retry 2',
    );
    assert.equal(
      formatWorkingWarning(
        'Retrying LLM stream (attempt 4): LLM HTTP 503 [SERVER]: overloaded',
        1,
      ),
      'Upstream 503 · retry 4',
    );
    assert.equal(
      formatWorkingWarning(
        'Retrying LLM stream (attempt 3): LLM HTTP 400: unsupported prompt_cache_key; dropping extra request fields',
        1,
      ),
      'Dropping extra fields · retry 3',
    );

    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.thinking);
    try {
      indicator.setMessage(formatWorkingWarning('Stream ended without a finish reason (none) — continuing the turn.', 2));
      const { plain } = statusLines(indicator, 120);
      assert.match(plain, /No finish reason \(2\)/);
      assert.equal(plain.includes('Thinking'), false);
    } finally {
      indicator.dispose();
    }
  });

  it('窄宽度时省略警告正文，次数与本轮耗时仍完整', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.thinking);
    try {
      indicator.setMessage(formatWorkingWarning(`LLM unknown dump ${'x'.repeat(80)}`, 12));
      const { plain } = statusLines(indicator, 48);
      assert.match(plain, /\(12\)/, '次数不能被省略号吃掉');
      assert.equal(/\(\d+…/.test(plain), false, '不能裁成 (1…');
      assert.match(plain.trimEnd(), /\d+\.\ds$/, '本轮耗时仍在右侧');
      assert.ok(plain.includes('…'), '正文超出时应省略');
    } finally {
      indicator.dispose();
    }
  });

  it('窄宽度时仍保留右侧本轮耗时', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.running('Bash', 'cargo test'));
    try {
      const { plain } = statusLines(indicator, 12);
      assert.match(plain.trimEnd(), /\d+\.\ds$/);
    } finally {
      indicator.dispose();
    }
  });

  it('工具文案带摘要，不写 Running', () => {
    assert.equal(WorkingLabel.running('Bash', 'cargo test'), 'Bash cargo test…');
    assert.equal(WorkingLabel.running('Read'), 'Read…');
  });
});

describe('复制反馈提示（输入框右上角）', () => {
  it('空闲态：提示 chip 落第二行右缘，clearHint 恢复空白占位', () => {
    const idle = new IdleStatus(() => {});
    try {
      assert.deepEqual(idle.render(40), ['', '']);
      idle.showHint('Copied!');
      const lines = idle.render(40);
      assert.equal(lines.length, 2);
      const raw = lines[1] ?? '';
      assert.equal(stripTerminalSequences(raw), ' Copied! ');
      // chip 反色，右缘与工作态右缘对齐（留 4 列），用 CHA 定位不铺空格。
      assert.match(raw, /\x1b\[7m/);
      assert.match(raw, /\x1b\[28G/);
      idle.clearHint();
      assert.deepEqual(idle.render(40), ['', '']);
    } finally {
      idle.clearHint();
    }
  });

  it('工作态：提示优先，本轮耗时与 token 让位；清除后恢复', () => {
    const indicator = new WorkingStatusIndicator(ui, WorkingLabel.working);
    try {
      indicator.setTokens(1470);
      indicator.showHint('Copied!');
      const { raw, plain } = statusLines(indicator, 60);
      assert.match(plain.trimEnd(), /Copied!$/);
      assert.equal(plain.includes('↓'), false, '提示期间 token 让位');
      const elapsedCount = (plain.match(/\d+\.\d?s/g) ?? []).length;
      assert.equal(elapsedCount, 1, '提示期间只剩阶段耗时，本轮耗时让位');
      assert.match(raw, /\x1b\[7m/, 'chip 用反色与 flash 同风格');
      indicator.clearHint();
      const restored = statusLines(indicator, 60);
      const restoredElapsed = (restored.plain.match(/\d+\.\d?s/g) ?? []).length;
      assert.equal(restoredElapsed, 2, '清除后本轮耗时恢复');
      assert.match(restored.plain, /↓1\.47k/);
    } finally {
      indicator.dispose();
    }
  });
});
