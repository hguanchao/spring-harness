import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { languageForDiffHeader, languageForPath, syntaxSpans } from '@/plugins/sph-tui/tools/diff-syntax.js';

describe('languageForPath', () => {
  it('按扩展名选语言，大小写不敏感', () => {
    assert.equal(languageForPath('E:\\demo\\bubble_sort.py'), 'python');
    assert.equal(languageForPath('/x/Y.TS'), 'typescript');
    assert.equal(languageForPath('a/b/c.cpp'), 'cpp');
  });

  it('无扩展名或未收录的语言返回 undefined', () => {
    assert.equal(languageForPath('Makefile'), undefined);
    assert.equal(languageForPath('E:\\a.b\\noext'), undefined);
    assert.equal(languageForPath('notes.tex'), undefined);
  });
});

describe('languageForDiffHeader', () => {
  it('从 +++ b/ 行取新文件语言，/dev/null 时退回 diff --git 行', () => {
    const lines = ['diff --git a/x.py b/x.py', 'index 1..2 100644', '+++ b/x.py', '@@ -1 +1 @@'];
    assert.equal(languageForDiffHeader(lines), 'python');
    const deleted = ['diff --git a/x.py b/x.py', '+++ /dev/null', '--- a/x.py'];
    assert.equal(languageForDiffHeader(deleted), 'python');
  });

  it('没有文件头就没有语言', () => {
    assert.equal(languageForDiffHeader(['@@ -1 +1 @@', '+x']), undefined);
  });
});

describe('syntaxSpans', () => {
  it('python 行拆出关键字/函数/注释角色，拼接恒等于原文', () => {
    const line = 'def bubble_sort(items):  # 排序';
    const spans = syntaxSpans(line, 'python');
    assert.equal(spans.map((span) => span.text).join(''), line);
    const colors = new Map(spans.map((span) => [span.text, span.color]));
    assert.equal(colors.get('def'), 'syntaxKeyword');
    assert.equal(colors.get('bubble_sort'), 'syntaxFunction');
    assert.equal(colors.get('# 排序'), 'syntaxComment');
    assert.ok(spans.find((span) => span.text === '# 排序')?.italic);
  });

  it('字符串与数字、内建调用各有其色', () => {
    // prism-python 沿用 Python 2 语义把 print 归为 keyword；len 才是 builtin。
    const spans = syntaxSpans('print("hi", 3)', 'python');
    const colors = new Map(spans.map((span) => [span.text, span.color]));
    assert.equal(colors.get('print'), 'syntaxKeyword');
    assert.equal(colors.get('"hi"'), 'syntaxString');
    assert.equal(colors.get('3'), 'syntaxConstant');
    const len = syntaxSpans('n = len(a)', 'python');
    assert.equal(new Map(len.map((span) => [span.text, span.color])).get('len'), 'syntaxFunction');
  });

  it('嵌套 token 展平后不丢文本', () => {
    const line = 'x = f"a{b}c"';
    const spans = syntaxSpans(line, 'python');
    assert.equal(spans.map((span) => span.text).join(''), line);
    assert.ok(spans.some((span) => span.color !== 'text'));
  });

  it('未知语言返回单段裸文本；纯文本行不上色', () => {
    assert.deepEqual(syntaxSpans('anything', 'nope'), [{ text: 'anything', color: 'text' }]);
    assert.deepEqual(syntaxSpans('   ', 'python'), [{ text: '   ', color: 'text' }]);
  });

  it('缓存命中返回同一结果', () => {
    const first = syntaxSpans('for i in range(n):', 'python');
    const second = syntaxSpans('for i in range(n):', 'python');
    assert.equal(first, second);
  });
});
