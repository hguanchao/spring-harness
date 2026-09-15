import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { colorIdeaInline, type IdeaInlineColors } from './idea-inline.js';

/** 用可读标签代替 ANSI，断言落在「哪个 token 拿到哪个角色」上。 */
const tag =
  (name: string) =>
  (text: string): string =>
    `<${name}>${text}</${name}>`;

const colors: IdeaInlineColors = {
  keyword: tag('kw'),
  method: tag('m'),
  constant: tag('c'),
  annotation: tag('a'),
  string: tag('s'),
  number: tag('n'),
  comment: tag('cm'),
  identifier: tag('id'),
};

describe('colorIdeaInline 角色判定', () => {
  it('关键字 / 字符串 / 注释 / 注解各归其位', () => {
    assert.equal(colorIdeaInline('public', colors), '<kw>public</kw>');
    assert.equal(colorIdeaInline('"x"', colors), '<s>"x"</s>');
    assert.equal(colorIdeaInline('// hi', colors), '<cm>// hi</cm>');
    assert.equal(colorIdeaInline('@Override', colors), '<a>@Override</a>');
  });

  it('全大写下划线常量走常量档', () => {
    assert.equal(colorIdeaInline('MAX_STEPS', colors), '<c>MAX_STEPS</c>');
  });

  it('树状图整行不拆词法，避免路径被切碎', () => {
    assert.equal(colorIdeaInline('├── model/  HttpMethod', colors), '<id>├── model/  HttpMethod</id>');
  });

  it('裸标识符与运算符走中性档', () => {
    assert.equal(colorIdeaInline('a + b', colors), '<id>a</id><id> </id><id>+</id><id> </id><id>b</id>');
  });
});

describe('colorIdeaInline 方法括号', () => {
  it('方法调用的括号与方法名同色', () => {
    assert.equal(colorIdeaInline('foo(1)', colors), '<m>foo</m><m>(</m><n>1</n><m>)</m>');
  });

  it('名字与括号之间隔空白也算同一个调用', () => {
    assert.equal(colorIdeaInline('foo (1)', colors), '<m>foo</m><id> </id><m>(</m><n>1</n><m>)</m>');
  });

  it('嵌套调用各自配对右括号', () => {
    assert.equal(
      colorIdeaInline('foo(bar(1))', colors),
      '<m>foo</m><m>(</m><m>bar</m><m>(</m><n>1</n><m>)</m><m>)</m>',
    );
  });

  it('不构成调用的括号保持中性档', () => {
    assert.equal(
      colorIdeaInline('(a + b)', colors),
      '<id>(</id><id>a</id><id> </id><id>+</id><id> </id><id>b</id><id>)</id>',
    );
  });

  it('调用里的普通括号不被连带染色', () => {
    // foo( (a+b) )：外层是调用，内层只是分组。
    assert.equal(
      colorIdeaInline('foo((a))', colors),
      '<m>foo</m><m>(</m><id>(</id><id>a</id><id>)</id><m>)</m>',
    );
  });

  it('空调用也把括号算进去', () => {
    assert.equal(colorIdeaInline('now()', colors), '<m>now</m><m>(</m><m>)</m>');
  });

  it('关键字后面的括号不是调用', () => {
    assert.equal(colorIdeaInline('if (a)', colors), '<kw>if</kw><id> </id><id>(</id><id>a</id><id>)</id>');
  });
});

describe('colorIdeaInline 注释要判位置', () => {
  it('URL 里的 // 不是注释', () => {
    assert.ok(!colorIdeaInline('https://api.example.com/v1/users', colors).includes('<cm>'));
    assert.ok(!colorIdeaInline('local/http://localhost:8080', colors).includes('<cm>'));
    assert.ok(!colorIdeaInline('DEFAULT_BASE=http://localhost:8080', colors).includes('<cm>'));
  });

  it('Python 整除 // 不是注释', () => {
    assert.ok(!colorIdeaInline('a // b', colors).includes('<cm>'));
  });

  it('行首与语句结束符后的 // 才是注释', () => {
    assert.equal(colorIdeaInline('// 计算哈希', colors), '<cm>// 计算哈希</cm>');
    assert.equal(
      colorIdeaInline('int n = 1; // 注释', colors),
      '<kw>int</kw><id> </id><id>n</id><id> </id><id>=</id><id> </id><n>1</n><id>;</id><id> </id><cm>// 注释</cm>',
    );
  });

  it('多行时 // 只吃到行尾', () => {
    assert.equal(colorIdeaInline('// a\ncode', colors), '<cm>// a</cm><id>\n</id><id>code</id>');
  });

  it('Javadoc 成员引用 # 不是注释', () => {
    assert.equal(colorIdeaInline('Class#method', colors), '<id>Class</id><id>#method</id>');
    assert.equal(colorIdeaInline('ToolsMenu#last', colors), '<id>ToolsMenu</id><id>#last</id>');
  });

  it('CSS 色值与选择器里的 # 不是注释', () => {
    assert.ok(!colorIdeaInline('color: #ffc66d', colors).includes('<cm>'));
    assert.ok(!colorIdeaInline('#main .title { color: red }', colors).includes('<cm>'));
  });

  it('Markdown 标题不是注释', () => {
    assert.ok(!colorIdeaInline('### 核心干的事', colors).includes('<cm>'));
  });

  it('# 注释 / shebang / 预处理器各归其位', () => {
    assert.equal(colorIdeaInline('# 说明', colors), '<cm># 说明</cm>');
    assert.equal(colorIdeaInline('#!/usr/bin/env bash', colors), '<cm>#!/usr/bin/env bash</cm>');
    assert.equal(colorIdeaInline('#', colors), '<cm>#</cm>');
    // 预处理器按元信息上色，而不是被当成注释。
    assert.equal(colorIdeaInline('#include <stdio.h>', colors), '<a>#include <stdio.h></a>');
  });

  it('块注释不受位置约束', () => {
    assert.equal(colorIdeaInline('/* 说明 */ value', colors), '<cm>/* 说明 */</cm><id> </id><id>value</id>');
  });
});

describe('colorIdeaInline 跨语言关键字', () => {
  it('高辨识度关键字各语言都能认', () => {
    assert.equal(colorIdeaInline('def', colors), '<kw>def</kw>');
    assert.equal(colorIdeaInline('func', colors), '<kw>func</kw>');
    assert.equal(colorIdeaInline('fn', colors), '<kw>fn</kw>');
    assert.equal(colorIdeaInline('impl', colors), '<kw>impl</kw>');
    assert.equal(colorIdeaInline('readonly', colors), '<kw>readonly</kw>');
    assert.equal(colorIdeaInline('esac', colors), '<kw>esac</kw>');
    assert.equal(colorIdeaInline('nil', colors), '<kw>nil</kw>');
    assert.equal(colorIdeaInline('None', colors), '<kw>None</kw>');
    assert.equal(colorIdeaInline('val', colors), '<kw>val</kw>');
  });

  it('真代码里的跨语言关键字完整上色', () => {
    assert.equal(
      colorIdeaInline('func main() { defer f() }', colors),
      '<kw>func</kw><id> </id><m>main</m><m>(</m><m>)</m><id> </id><id>{</id><id> </id><kw>defer</kw><id> </id><m>f</m><m>(</m><m>)</m><id> </id><id>}</id>',
    );
  });

  it('与英文同形的词一律不收，避免散文误判', () => {
    // 这些在真实语料里 100% 出现在标识符或英文散文里（Install Plugin from Disk、
    // action.export|export.postman、local/http://…、notification.scan.done=…）。
    for (const word of ['from', 'type', 'as', 'local', 'done', 'module', 'export', 'object', 'range', 'map', 'join', 'update', 'in', 'is', 'not', 'end', 'then']) {
      assert.equal(colorIdeaInline(word, colors), `<id>${word}</id>`, `${word} 不该被当关键字`);
    }
  });

  it('紧跟 = 的关键字是配置项名', () => {
    assert.equal(
      colorIdeaInline('class=RefreshEndpointsAction', colors),
      '<id>class</id><id>=</id><id>RefreshEndpointsAction</id>',
    );
    // 空格隔开的才是真关键字。
    assert.equal(colorIdeaInline('class Foo', colors), '<kw>class</kw><id> </id><id>Foo</id>');
  });
});

describe('colorIdeaInline 树状图', () => {
  it('常见 box-drawing 字符都触发整行不上色', () => {
    for (const glyph of ['├', '│', '└', '─', '┃', '━', '╭', '╮', '╰', '╯', '┼', '┄', '┈', '╌']) {
      const input = `${glyph}── foo() // x`;
      assert.equal(colorIdeaInline(input, colors), `<id>${input}</id>`, `${glyph} 应触发整行不上色`);
    }
  });
});
