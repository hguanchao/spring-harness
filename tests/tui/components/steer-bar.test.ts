import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SteeringInbox } from '../../../src/plugins/sph-schedule/jobs.js';
import { SteerBar } from '../../../src/plugins/sph-tui/steer-bar.js';
import { theme } from '../../../src/plugins/sph-tui/theme/theme.js';
import { stripTerminalSequences } from '../../../src/tui/utils.js';

describe('挂起条序号', () => {
  it('序号前有中性灰的 #', () => {
    const inbox: SteeringInbox = {
      peek: () => ['稍后发送'],
      push() {},
      drain: () => [],
      removeLast: () => undefined,
      full: () => false,
      move: () => false,
      removeAt: () => undefined,
      insertAt() {},
    };
    const bar = new SteerBar(inbox, {
      requestRender() {},
      invalidateContent() {},
      focusEditor() {},
      editor: { getText: () => '', setText() {} },
      canInterrupt: () => false,
      sendNow() {},
    });
    const line = bar.component.render(80)[1] ?? '';
    const hash = theme.fg('muted', '#');
    assert.ok(line.includes(hash), '序号前的 # 应为中性灰');
    assert.ok(line.includes(theme.fg('primary', '1.')));
    assert.match(stripTerminalSequences(line), /#1\. 稍后发送/);
  });
});
