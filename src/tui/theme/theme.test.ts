import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Markdown } from '../components/markdown.js';
import { getMarkdownTheme, highlightCode, theme } from './theme.js';

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

  it('带语言的围栏同样整块同色，不再上语法色', () => {
    const lines = highlightCode('public class Foo { return "s"; } // hi', 'java');
    assert.equal(distinctColors(lines).length, 1, `expected one color, got ${distinctColors(lines).join(',')}`);
  });

  it('围栏与块内正文同色，语言标签只剩信息意义', () => {
    const theme = getMarkdownTheme();
    const fenceColor = colorsOf(theme.codeBlockBorder('```java'))[0];
    for (const lang of ['java', 'python', 'bash', 'text', undefined, 'not-a-real-language']) {
      const codes = distinctColors(highlightCode('@Override public void f() { return "x"; } // c', lang));
      assert.deepEqual(codes, [fenceColor], `${lang ?? '(none)'} 应与围栏同色`);
    }
  });

  it('text 围栏的内容色与围栏色一致', () => {
    const theme = getMarkdownTheme();
    const [line] = highlightCode('some text', 'text');
    assert.equal(colorsOf(line ?? '')[0], colorsOf(theme.codeBlockBorder('```'))[0]);
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

  it('方法与它的括号同色，且与注解色不同', () => {
    const markdownTheme = getMarkdownTheme();
    // foo(x)：方法名 + 左括号 + 参数 + 右括号。行内蓝收敛后参数也走同一档。
    const codes = colorsOf(markdownTheme.code('foo(x)'));
    assert.equal(codes.length, 4, `expected 4 colored runs, got ${codes.join(',')}`);
    assert.equal(codes[0], codes[1], '方法名与左括号应同色');
    assert.equal(codes[0], codes[3], '右括号应与方法名同色');
    assert.equal(codes[0], codes[2], '标识符与方法共用行内蓝');
    assert.notEqual(codes[0], colorsOf(markdownTheme.code('@Override'))[0]);
  });

  it('裸行内码用蓝色，和正文分开', () => {
    const markdownTheme = getMarkdownTheme();
    const inline = colorsOf(markdownTheme.code('Spring MVC'))[0];
    const body = colorsOf(theme.fg('mdText', 'Spring MVC'))[0];
    const method = colorsOf(markdownTheme.code('now()'))[0];
    assert.ok(inline);
    assert.notEqual(inline, body, '行内码不能再跟正文同色');
    assert.equal(inline, method, '裸标识符与方法共用行内蓝');
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

  it('引用块外的行内代码仍然自带颜色', () => {
    const lines = markdownOf('prose with `Spring MVC` inside')
      .render(60)
      .filter((line) => line.includes('prose'));
    assert.equal(lines.length, 1);
    assert.equal(distinctColors(lines).length, 2);
  });
});
