import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '@/tui/widgets/markdown.js';
import { getMarkdownTheme, theme } from '@/plugins/sph-tui/theme/theme.js';
import { visibleWidth } from '@/tui/text/utils.js';

const STRIP = /\x1b\[[0-9;]*m/g;

function plain(source: string): string {
  const md = new Markdown(source, 0, 0, getMarkdownTheme(), {
    color: (content: string) => theme.fg('mdText', content),
  });
  return md.render(40).map((line) => line.replace(STRIP, '').trimEnd()).join('\n');
}

describe('h3 横线标题', () => {
  it('破折号铺满内容宽，标题文字夹在中间', () => {
    const md = new Markdown('### Skills 5', 0, 0, getMarkdownTheme(), {
      color: (content: string) => theme.fg('mdText', content),
    });
    const width = 40;
    const line = md.render(width)[0] ?? '';
    const bare = line.replace(STRIP, '');
    assert.match(bare, /^—— Skills 5 /);
    assert.equal(bare.includes('#'), false, '井号前缀不进画面');
    assert.equal(visibleWidth(line), width, '横线占满内容宽');
  });
});

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
