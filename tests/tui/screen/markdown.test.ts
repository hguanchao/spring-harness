import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '../../../src/tui/markdown.js';
import { getMarkdownTheme, theme } from '../../../src/plugins/sph-tui/theme/theme.js';

const STRIP = /\x1b\[[0-9;]*m/g;

function plain(source: string): string {
  const md = new Markdown(source, 0, 0, getMarkdownTheme(), {
    color: (content: string) => theme.fg('mdText', content),
  });
  return md.render(40).map((line) => line.replace(STRIP, '').trimEnd()).join('\n');
}

describe('Markdown 流式围栏', () => {
  it('半截闭合围栏不进代码正文', () => {
    const lines = plain('```\nhello\n``').split('\n');
    assert.ok(lines.some((line) => line.includes('hello')));
    assert.equal(lines.some((line) => line.trim() === '``'), false);
  });

  it('完整围栏保留代码正文', () => {
    const text = plain('```ts\nconst x = 1;\n```');
    assert.ok(text.includes('const x = 1;'));
    assert.ok(text.includes('```ts'));
  });
});
