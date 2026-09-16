import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quoteCommandLineArg as q } from './command-line.js';

/**
 * 期望值都按「实际的命令行文本」写：TS 源码里反斜杠要转义，所以 `'a\\\\'` 表示两个反斜杠。
 */
describe('quoteCommandLineArg', () => {
  it('不含空格/引号时原样输出', () => {
    assert.equal(q('plain'), 'plain');
    assert.equal(q('C:\\temp'), 'C:\\temp');
    assert.equal(q('a\\b\\'), 'a\\b\\');
  });

  it('空串要引起来，否则整段参数会消失', () => {
    assert.equal(q(''), '""');
  });

  it('含空格时加引号', () => {
    assert.equal(q('a b'), '"a b"');
    assert.equal(q('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  });

  it('引号前补转义反斜杠', () => {
    assert.equal(q('a"b'), '"a\\"b"');
    assert.equal(q('"'), '"\\""');
  });

  it('引号前的连续反斜杠翻倍，否则会把引号吃掉', () => {
    assert.equal(q('a\\"b'), '"a\\\\\\"b"');
  });

  it('末尾反斜杠翻倍：不翻倍会顶掉收尾引号，整段拼错位', () => {
    // 这是本轮修的回归点：旧实现只把 " 换成 \"，于是
    // `Copy-Item a.txt C:\temp\` → `"...C:\temp\"` → 解析回来多一个引号，命令坏掉。
    assert.equal(q('C:\\my dir\\'), '"C:\\my dir\\\\"');
    assert.equal(q('Copy-Item a.txt C:\\temp\\'), '"Copy-Item a.txt C:\\temp\\\\"');
    assert.equal(q('trailing\\'), 'trailing\\', '不含空格时不加引号，反斜杠无需翻倍');
  });

  it('反斜杠后面既不是引号也不是结尾时不翻倍', () => {
    assert.equal(q('a\\ b'), '"a\\ b"');
    assert.equal(q('a\\b c'), '"a\\b c"');
  });

  it('整体是一个可被 CommandLineToArgvW 还原的片段', () => {
    // 手工按解析规则反向还原：引号外的字符原样，引号内 \\ → \ 、\" → "。
    const cases = ['a b', 'a"b', 'C:\\my dir\\', 'a\\"b', '\\\\', 'x \\ y\\'];
    for (const arg of cases) {
      const encoded = q(arg);
      assert.equal(decodeWindows(encoded), arg, `往返失败：${JSON.stringify(arg)} → ${encoded}`);
    }
  });
});

/**
 * 一个最小实现的反向解析器，只为给上一条用例当独立参照。
 * 只处理本函数会产出的形态：整段被引号包住，或完全无引号。
 */
function decodeWindows(encoded: string): string {
  if (!encoded.startsWith('"')) return encoded;
  const body = encoded.slice(1, -1);
  let out = '';
  let backslashes = 0;
  for (const char of body) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') {
      // 编码侧把 k 个反斜杠写成 2k+1 个再跟一个引号：2k+1 → k 个反斜杠 + 一个字面引号。
      out += `${'\\'.repeat(Math.floor(backslashes / 2))}"`;
      backslashes = 0;
      continue;
    }
    // 后面不是引号的连续反斜杠是逐字写进去的。
    out += `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  // 收尾的反斜杠被编码成 2k 个。
  return `${out}${'\\'.repeat(backslashes / 2)}`;
}
