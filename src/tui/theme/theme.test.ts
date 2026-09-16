import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '../components/markdown.js';
import { PALETTE } from './palettes.js';
import {
  getMarkdownTheme,
  oscResetCanvasBackground,
  oscSetCanvasBackground,
  Theme,
  theme,
} from './theme.js';

/** 只看前景色 SGR，忽略加粗/斜体等修饰。 */
const FG = /\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/g;

/** 剥掉全部 SGR 序列，只留可读文本（判断行内容时用）。 */
const STRIP = /\x1b\[[0-9;]*m/g;

function colorsOf(text: string): string[] {
  return text.match(FG) ?? [];
}

function distinctColors(lines: readonly string[]): string[] {
  return [...new Set(lines.flatMap(colorsOf))];
}

/** 与 AssistantMessageComponent 同参构造，正文才有底色可比。 */
function markdownOf(text: string): Markdown {
  return new Markdown(text, 0, 0, getMarkdownTheme(), { color: (content: string) => theme.fg('mdText', content) });
}

describe('代码块统一中性灰', () => {
  /**
   * 回归点：带语言标签的围栏曾走 highlight.js 语法色（蓝系关键字 + 多彩字符串），
   * 无语言围栏却是中性灰——同一个回答里两种代码块两种配色，用户要求统一灰。
   * 现在渲染面不再接高亮：所有代码块内容一律 mdCodeBlock 灰，`highlightCode` 整条链路已删。
   */
  it('带语言与无语言的围栏都只产出 mdCodeBlock 灰', () => {
    const muted = colorsOf(theme.fg('mdCodeBlock', 'x'))[0];
    const md = markdownOf(
      '```bash\nnpm run build          # 打包\nnpm run sph\n```\n\n```\nsome tree\n└── leaf\n```',
    );
    const body = md.render(100);
    // 跳过首尾围栏装饰行（mdCodeBlockBorder，同为灰系），只看代码内容行。
    const contentLines = body.filter((line) => !line.replace(STRIP, '').includes('```'));
    const codeLines = contentLines.filter((line) => /npm run|some tree/.test(line.replace(STRIP, '')));
    assert.ok(codeLines.length >= 3, `应有代码内容行，实际: ${codeLines.join(' | ')}`);
    for (const line of codeLines) {
      assert.deepEqual(
        distinctColors([line]),
        [muted],
        `代码内容行应只有中性灰，实际: ${distinctColors([line]).join(',')} — ${line}`,
      );
    }
  });

  it('语法高亮链路已整体移除：主题不提供 highlightCode，syntax 色板不再出现在代码块里', () => {
    const themeObj = getMarkdownTheme();
    assert.equal(themeObj.highlightCode, undefined, '主题不再接高亮');
    const syntax = colorsOf(theme.fg('syntaxKeyword', 'x'))[0];
    const body = markdownOf('```bash\nnpm run build\n```').render(100);
    assert.equal(
      body.some((line) => colorsOf(line).includes(syntax)),
      false,
      '代码块里不应再出现 syntax 蓝',
    );
  });
});

describe('代码档配色分工', () => {
  it('围栏与代码块正文同色，块内不再灰白相间', () => {
    const theme = getMarkdownTheme();
    assert.equal(colorsOf(theme.codeBlock('x'))[0], colorsOf(theme.codeBlockBorder('```'))[0]);
  });

  it('行内代码比代码块亮一档，避免夹在正文里糊掉', () => {
    const theme = getMarkdownTheme();
    assert.notEqual(colorsOf(theme.code('x'))[0], colorsOf(theme.codeBlock('x'))[0]);
  });

  it('高亮已移除：块内不会再出现灰白相间', () => {
    // 旧断言verify highlight.js 的标点落在块正文色上；现在没有高亮，块内天然单色。
    const theme = getMarkdownTheme();
    const blockColor = colorsOf(theme.codeBlock('class Foo {}'))[0];
    assert.ok(blockColor, '代码块着色函数仍应产出前景色');
  });

  it('行内码整段单色，注解和标识符不再分色', () => {
    const markdownTheme = getMarkdownTheme();
    const ident = colorsOf(markdownTheme.code('Spring MVC'));
    const method = colorsOf(markdownTheme.code('now()'));
    const anno = colorsOf(markdownTheme.code('@Override'));
    assert.equal(ident.length, 1);
    assert.equal(method.length, 1);
    assert.equal(anno.length, 1);
    assert.equal(ident[0], method[0]);
    assert.equal(ident[0], anno[0]);
  });

  it('行内码整段语法蓝，与正文、代码块灰都不同', () => {
    const markdownTheme = getMarkdownTheme();
    const inline = colorsOf(markdownTheme.code('Spring MVC'))[0];
    const body = colorsOf(theme.fg('mdText', 'Spring MVC'))[0];
    const block = colorsOf(markdownTheme.codeBlock('Spring MVC'))[0];
    const syntax = colorsOf(theme.fg('syntaxKeyword', 'x'))[0];
    assert.equal(inline, syntax);
    assert.notEqual(inline, body);
    assert.notEqual(inline, block);
  });
});

describe('引用块里的行内代码', () => {
  it('跟随引用一起压暗，不再从灰底里跳出', () => {
    const quoteLines = markdownOf('> quote with `now()` inside')
      .render(60)
      .filter((line) => line.includes('quote'));
    assert.equal(quoteLines.length, 1);
    // 修复前行内码自带一层更亮的前景色，整行会出现两种颜色。
    assert.equal(distinctColors(quoteLines).length, 1, `expected one color, got ${distinctColors(quoteLines).join(',')}`);
  });

  it('引用块外的行内码是蓝，正文是灰', () => {
    const lines = markdownOf('prose with `Spring MVC` inside')
      .render(60)
      .filter((line) => line.includes('prose'));
    assert.equal(lines.length, 1);
    const codes = distinctColors(lines);
    assert.ok(codes.includes(colorsOf(theme.fg('mdText', 'x'))[0] ?? ''));
    assert.ok(codes.includes(colorsOf(theme.fg('syntaxKeyword', 'x'))[0] ?? ''));
  });
});

describe('画布底色', () => {
  it('主色是 OpenCode 紫，不是 Material / TokyoNight 品红', () => {
    assert.equal(PALETTE.primary, '#9d7cd8');
    assert.notEqual(PALETTE.primary, '#9575cd');
    assert.notEqual(PALETTE.primary, '#bb9af7');
  });

  it('语法蓝是 OpenCode 蓝，不是 Material / TokyoNight 亮蓝', () => {
    assert.equal(PALETTE.syntaxKeyword, '#5c9cf5');
    assert.notEqual(PALETTE.syntaxKeyword, '#64b5f6');
    assert.notEqual(PALETTE.syntaxKeyword, '#7aa2f7');
  });

  it('红黄绿与 OpenCode 默认暗色主题一致', () => {
    assert.equal(PALETTE.error, '#e06c75');
    assert.equal(PALETTE.warning, '#f5a742');
    assert.equal(PALETTE.success, '#7fd88f');
  });

  it('正文白是 #c6c6c6，不是终端默认 #cccccc', () => {
    assert.equal(PALETTE.text, '#c6c6c6');
    assert.equal(PALETTE.mdText, '#c6c6c6');
    const t = new Theme(PALETTE, 'truecolor');
    assert.equal(t.fg('text', 'x'), '\x1b[38;2;198;198;198mx\x1b[39m');
  });

  it('与 GrokNight bg_base 一致，OSC 11 用真 hex', () => {
    assert.equal(PALETTE.bg, '#141414');
    const t = new Theme(PALETTE, 'truecolor');
    assert.equal(t.bgSeq('bg'), '\x1b[48;2;20;20;20m');
    assert.equal(oscSetCanvasBackground(), '\x1b]11;#141414\x07');
    assert.equal(oscResetCanvasBackground(), '\x1b]111\x07');
  });
});

describe('标题与列表强调色', () => {
  const primary = colorsOf(theme.fg('primary', 'x'))[0];

  it('各级标题（含 h4-6）都是品牌紫', () => {
    // h4-6 曾是正文白：夹在紫的 h1-3 之间深浅不一，用户要求标题统一紫。
    const md = getMarkdownTheme();
    for (const depth of [1, 2, 3, 4, 5, 6] as const) {
      const colors = colorsOf(md.heading('标题', depth));
      assert.ok(colors.includes(primary), 'h' + depth + ' 应含品牌紫，实际: ' + colors.join(','));
    }
  });

  it('列表符号与有序序号都是品牌紫', () => {
    const md = getMarkdownTheme();
    assert.ok(colorsOf(md.listBullet('- ')).includes(primary), '无序列表符号应为品牌紫');
    assert.ok(colorsOf(md.listBullet('1. ')).includes(primary), '有序序号应为品牌紫');
  });
});

describe('终端默认配色（ansi 模式）', () => {
  const ansi = new Theme(PALETTE, 'ansi');

  it('语义色映射到基础 ANSI 码，颜色交由终端主题决定', () => {
    assert.equal(ansi.fg('primary', 'x'), '\x1b[95mx\x1b[39m');
    assert.equal(ansi.fg('mdH4', 'x'), '\x1b[95mx\x1b[39m');
    assert.equal(ansi.fg('text', 'x'), '\x1b[39mx\x1b[39m', '正文=终端默认前景');
    assert.equal(ansi.fg('muted', 'x'), '\x1b[90mx\x1b[39m');
    assert.equal(ansi.fg('mdCode', 'x'), '\x1b[94mx\x1b[39m');
    assert.equal(ansi.fg('error', 'x'), '\x1b[91mx\x1b[39m');
  });

  it('画布交还终端默认底（49），面层用亮黑（100）', () => {
    assert.equal(ansi.bg('bg', 'x'), '\x1b[49mx\x1b[49m');
    assert.equal(ansi.bgSeq('bg'), '\x1b[49m');
    assert.equal(ansi.bg('userMessageBg', 'x'), '\x1b[100mx\x1b[49m');
  });

  it('未映射的键回落默认前景，不抛错', () => {
    assert.equal(ansi.fg('syntaxKeyword', 'x'), '\x1b[39mx\x1b[39m');
  });
});
