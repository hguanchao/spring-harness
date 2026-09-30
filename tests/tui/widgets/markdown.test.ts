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
  it('线条铺满内容宽，标题文字夹在中间', () => {
    const md = new Markdown('### Skills 5', 0, 0, getMarkdownTheme(), {
      color: (content: string) => theme.fg('mdText', content),
    });
    const width = 40;
    const line = md.render(width)[0] ?? '';
    const bare = line.replace(STRIP, '');
    // 线条用制表符 `─`，与弹窗边框同一套字形；长破折号 `—` 会显得比边框重一档。
    assert.match(bare, /^─ Skills 5 /);
    assert.equal(bare.includes('#'), false, '井号前缀不进画面');
    assert.equal(bare.includes('—'), false, '横线里不出现长破折号');
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

describe('词项列（报告弹窗的条目排版）', () => {
  function termLines(source: string, width = 40): string[] {
    const md = new Markdown(source, 0, 0, getMarkdownTheme(), {
      color: (content: string) => theme.fg('mdText', content),
    }, { termColumnLists: true });
    return md.render(width).map((line) => line.replace(STRIP, '').replace(/\s+$/, ''));
  }

  it('整块都是「行内码 + 连接号 + 说明」时排成两列，连接号不再上屏', () => {
    const lines = termLines('- `a` — one\n- `bb` — two');
    assert.equal(lines.join('\n').includes('—'), false, '有列轨之后连接号是多余标点');
    const first = lines.findIndex((line) => line.includes('one'));
    const second = lines.findIndex((line) => line.includes('two'));
    assert.ok(first >= 0 && second >= 0);
    assert.equal(lines[first].indexOf('one'), lines[second].indexOf('two'), '两条的说明列同一格起');
  });

  it('说明折行回到说明列，不回到词项列', () => {
    const lines = termLines('- `pdf` — Fill PDF forms and then merge a long tail that cannot fit', 40);
    assert.ok(lines[0].includes('pdf'));
    assert.ok(lines.length > 1, '这么长的说明一定要折行');
    const descriptionColumn = lines[0].indexOf('Fill');
    assert.equal(lines[1].search(/\S/), descriptionColumn, '续行的第一个字与首行说明同列');
    for (const line of lines) assert.equal(visibleWidth(line) <= 40, true, `不越宽：${line}`);
  });

  it('有一条不是行内码开头时，整块退回普通列表——半转换的锯齿最刺眼', () => {
    const lines = termLines('- `a` — one\n- plain — two');
    assert.equal(lines[0], '- a — one', '保留圆点与连接号的原样排版');
    assert.ok(lines.some((line) => line.includes('— two')), '连接号没被吃掉');
  });

  it('词项超过列上限时独占一行，说明退到下一行的说明列', () => {
    const longTerm = 'x'.repeat(30);
    const lines = termLines(`- \`${longTerm}\` — desc`, 40);
    assert.equal(lines.length, 2, '词项一行、说明一行');
    assert.ok(lines[0].startsWith('  ') && lines[0].includes(longTerm));
    assert.ok(lines[1].includes('desc'));
    for (const line of lines) assert.equal(visibleWidth(line) <= 40, true, `不越宽：${line}`);
  });

  it('有序列表也走列轨：号 · 词项 · 说明三列对齐（/permissions 的规则行）', () => {
    const lines = termLines('1. `deny` — bash(rm *)\n2. `allow` — bash(npm *)\n3. `ask` — bash(git push *)');
    assert.equal(lines[0], '1. deny   bash(rm *)', '号在最外，动作是词项列');
    assert.equal(lines[1], '2. allow  bash(npm *)');
    assert.equal(lines[2], '3. ask    bash(git push *)');
    assert.equal(lines.join('\n').includes('—'), false, '连接号同样不上屏');
  });

  it('号列宽按整块最大号算：9→10 不把词项列推右一格', () => {
    const source = Array.from({ length: 10 }, (_, index) => `${index + 1}. \`deny\` — r${index}`).join('\n');
    const lines = termLines(source, 60);
    const columns = lines.map((line) => line.indexOf('deny') >= 0 ? line.indexOf('deny') : -1).filter((at) => at >= 0);
    assert.equal(new Set(columns).size, 1, `所有行的词项列同一格起：${JSON.stringify(columns)}`);
  });

  it('没开词项列就是原样（转录里模型自己写的 — 不能被替它吃掉）', () => {
    const md = new Markdown('- `a` — one', 0, 0, getMarkdownTheme(), {
      color: (content: string) => theme.fg('mdText', content),
    });
    const line = md.render(40)[0].replace(STRIP, '');
    assert.ok(line.includes('— one'), '默认关：这条链路属于转录，标点归作者');
  });
});

describe('内联标记', () => {
  function rendered(source: string): string {
    const md = new Markdown(source, 0, 0, getMarkdownTheme(), {
      color: (content: string) => theme.fg('mdText', content),
    });
    return md.render(80).join('\n');
  }

  it('%%…%% 画成中性灰，内容逐字保留（路径里的下划线与星号不被当成标记）', () => {
    const line = rendered('path: %%/ws/_draft/a*b.md%%');
    assert.ok(line.includes(theme.fg('muted', '/ws/_draft/a*b.md')), '弱化信息走 muted 画笔');
    assert.equal(line.includes(theme.fg('mdCode', '/ws/_draft/a*b.md')), false, '不再与行内码同档蓝');
  });

  it('{{…}} 仍是行内码那一档蓝，两种标记各走各的画笔', () => {
    const line = rendered('1. {{/ws/skills}}');
    assert.ok(line.includes(theme.fg('mdCode', '/ws/skills')));
    assert.equal(line.includes(theme.fg('muted', '/ws/skills')), false);
  });
});
