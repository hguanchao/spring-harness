import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecapMessageComponent } from '../../../src/plugins/sph-tui/components/recap.js';
import { BLOCK_GAP, stripTerminalSequences, visibleWidth } from '../../../src/tui/index.js';

/** 组件按主题上色（theme.fg 始终发 ANSI），断言前先剥掉转义序列。 */
function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line));
}

describe('RecapMessageComponent', () => {
  it('renders nothing for an empty, settled recap', () => {
    assert.deepEqual(new RecapMessageComponent('').render(80), []);
  });

  it('renders the body on one line under a leading block gap', () => {
    const lines = plain(new RecapMessageComponent('We fixed the parser.').render(80));
    assert.equal(lines.length, BLOCK_GAP + 1);
    assert.equal(lines[0], '');
    assert.equal(lines[1], '   ◆ Recap — We fixed the parser.');
  });

  it('shows a pending line while a manual recap generates', () => {
    const component = new RecapMessageComponent('', true);
    assert.equal(component.isPending, true);
    assert.equal(plain(component.render(80))[1], '   ◇ Recap — summarizing…');
  });

  it('replaces the pending line in place once the summary arrives', () => {
    const component = new RecapMessageComponent('', true);
    component.setSummary('You asked how the retry budget works.');
    assert.equal(component.isPending, false);
    assert.equal(plain(component.render(80))[1], '   ◆ Recap — You asked how the retry budget works.');
  });

  it('hangs continuation lines at the body column', () => {
    const body = 'word '.repeat(40).trim();
    const lines = plain(new RecapMessageComponent(body).render(40));
    assert.ok(lines.length > BLOCK_GAP + 1, 'a long body must wrap');
    assert.ok(lines[BLOCK_GAP]?.startsWith('   ◆ Recap — '), `head line: ${lines[BLOCK_GAP]}`);
    for (const line of lines.slice(BLOCK_GAP + 1)) {
      assert.ok(line.startsWith('     '), `continuation must be indented: ${line}`);
    }
  });

  it('never renders a line wider than the viewport', () => {
    const body = 'identifier '.repeat(60).trim();
    for (const width of [20, 40, 80]) {
      for (const line of new RecapMessageComponent(body).render(width)) {
        assert.ok(visibleWidth(line) <= width, `line overflows ${width}: ${visibleWidth(line)}`);
      }
    }
  });
});
