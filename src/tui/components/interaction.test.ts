import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../core/index.js';
import { stripTerminalSequences, visibleWidth } from '../core/index.js';
import { WorkingLabel, WorkingStatusIndicator } from './interaction.js';

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
