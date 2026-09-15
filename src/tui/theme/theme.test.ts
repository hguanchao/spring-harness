import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '../components/markdown.js';
import { PALETTE } from './palettes.js';
import {
  getMarkdownTheme,
  highlightCode,
  oscResetCanvasBackground,
  oscSetCanvasBackground,
  Theme,
  theme,
} from './theme.js';

/** 只看前景色 SGR，忽略加粗/斜体等修饰。 */
const FG = /\x1b\[38;(?:5;\d+|2;\d+;\d+;\d+)m/g;

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

describe('highlightCode', () => {
  it('text 围栏整块同色，不做词法猜测', () => {
    // 目录清单里的 RestEndpointPathTest(4) 曾经被当成方法调用染成金色。
    const lines = highlightCode(
      'src/test/  RestEndpointPathTest(4) 纯逻辑JUnit4\n├── model/  HttpMethod, RestEndpoint',
      'text',
    );
    assert.equal(distinctColors(lines).length, 1, `expected one color, got ${distinctColors(lines).join(',')}`);
  });

  it('无语言围栏同样整块同色', () => {
    const lines = highlightCode('plain fenced line\nsecond line', undefined);
    assert.equal(distinctColors(lines).length, 1);
  });

  it('未知语言不上色，也不做 highlightAuto', () => {
    const lines = highlightCode('some tree\n└── leaf', 'not-a-real-language');
    assert.equal(distinctColors(lines).length, 1);
  });

  it('带语言的围栏上蓝色语法色，关键字与正文灰不同色', () => {
    const lines = highlightCode('public class Foo { return "s"; } // hi', 'java');
    const fence = colorsOf(getMarkdownTheme().codeBlockBorder('```'))[0];
    const codes = distinctColors(lines);
    assert.ok(codes.length >= 2, `expected syntax colors, got ${codes.join(',')}`);
    assert.ok(codes.some((c) => c !== fence), 'tagged fence must use a color besides muted');
  });

  it('无语言 / text / 未知语言整块中性灰，不上蓝', () => {
    const muted = colorsOf(theme.fg('mdCodeBlock', 'x'))[0];
    const body = colorsOf(theme.fg('mdText', 'x'))[0];
    const syntax = colorsOf(theme.fg('syntaxKeyword', 'x'))[0];
    for (const lang of ['text', undefined, 'not-a-real-language']) {
      const codes = distinctColors(highlightCode('@Override public void f() { return "x"; } // c', lang));
      assert.deepEqual(codes, [muted], `${lang ?? '(none)'} 应与代码块灰同色`);
      assert.notEqual(muted, body);
      assert.notEqual(muted, syntax);
    }
  });

  it('text 围栏的内容色与围栏灰一致', () => {
    const [line] = highlightCode('some text', 'text');
    assert.equal(colorsOf(line ?? '')[0], colorsOf(getMarkdownTheme().codeBlockBorder('```'))[0]);
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

  it('高亮块里的标点与块正文同色，块内不会灰白相间', () => {
    const theme = getMarkdownTheme();
    const blockColor = colorsOf(theme.codeBlock('x'))[0];
    // class 是关键字、Foo 是类型、{} 是标点：标点必须落在块正文色上。
    const codes = colorsOf(highlightCode('class Foo {}', 'java').join('\n'));
    assert.ok(
      codes.includes(blockColor ?? ''),
      `punctuation must use the block color, got ${codes.join(',')}`,
    );
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
  it('主色是 Material Deep Purple 300，不是 TokyoNight 品红', () => {
    assert.equal(PALETTE.primary, '#9575cd');
    assert.notEqual(PALETTE.primary, '#bb9af7');
  });

  it('语法蓝是 Material Blue 300，不是 TokyoNight 亮蓝', () => {
    assert.equal(PALETTE.syntaxKeyword, '#64b5f6');
    assert.notEqual(PALETTE.syntaxKeyword, '#7aa2f7');
  });

  it('与 GrokNight bg_base 一致，OSC 11 用真 hex', () => {
    assert.equal(PALETTE.bg, '#141414');
    const t = new Theme(PALETTE, 'truecolor');
    assert.equal(t.bgSeq('bg'), '\x1b[48;2;20;20;20m');
    assert.equal(oscSetCanvasBackground(), '\x1b]11;#141414\x07');
    assert.equal(oscResetCanvasBackground(), '\x1b]111\x07');
  });
});
