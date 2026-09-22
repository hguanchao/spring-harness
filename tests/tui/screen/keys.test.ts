import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  decodePrintableKey,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from '../../../src/tui/screen/keys.js';

afterEach(() => {
  setKittyProtocolActive(false);
});

describe('parseKey 遗留序列', () => {
  it('方向键、功能键、回车退格', () => {
    assert.equal(parseKey('\x1b[A'), 'up');
    assert.equal(parseKey('\x1bOA'), 'up');
    assert.equal(parseKey('\x1b[B'), 'down');
    assert.equal(parseKey('\x1b[C'), 'right');
    assert.equal(parseKey('\x1b[D'), 'left');
    assert.equal(parseKey('\x1b[H'), 'home');
    assert.equal(parseKey('\x1b[1~'), 'home');
    assert.equal(parseKey('\x1b[F'), 'end');
    assert.equal(parseKey('\x1b[4~'), 'end');
    assert.equal(parseKey('\x1b[3~'), 'delete');
    assert.equal(parseKey('\x1b[5~'), 'pageUp');
    assert.equal(parseKey('\x1b[6~'), 'pageDown');
    assert.equal(parseKey('\x1bOP'), 'f1');
    assert.equal(parseKey('\r'), 'enter');
    assert.equal(parseKey('\n'), 'enter');
    assert.equal(parseKey('\t'), 'tab');
    assert.equal(parseKey('\x1b[Z'), 'shift+tab');
    assert.equal(parseKey('\x1b'), 'escape');
    assert.equal(parseKey('\x7f'), 'backspace');
    assert.equal(parseKey(' '), 'space');
  });

  it('ctrl / alt 组合', () => {
    assert.equal(parseKey('\x03'), 'ctrl+c');
    assert.equal(parseKey('\x04'), 'ctrl+d');
    assert.equal(parseKey('\x00'), 'ctrl+space');
    assert.equal(parseKey('\x1b\r'), 'alt+enter');
    assert.equal(parseKey('\x1b '), 'alt+space');
    assert.equal(parseKey('\x1b\x7f'), 'alt+backspace');
    assert.equal(parseKey('\x1bb'), 'alt+left');
    assert.equal(parseKey('\x1bf'), 'alt+right');
    assert.equal(parseKey('\x1bc'), 'alt+c');
    assert.equal(parseKey('\x1b\x03'), 'ctrl+alt+c');
  });

  it('Kitty 开启后 \\n 和 ESC+CR 是 shift+enter，不再是 enter / alt+enter', () => {
    setKittyProtocolActive(true);
    assert.equal(parseKey('\n'), 'shift+enter');
    assert.equal(parseKey('\x1b\r'), 'shift+enter');
    assert.equal(parseKey('\r'), 'enter');
  });
});

describe('parseKey Kitty CSI-u', () => {
  it('字母、修饰键、功能键', () => {
    assert.equal(parseKey('\x1b[99u'), 'c');
    assert.equal(parseKey('\x1b[99;5u'), 'ctrl+c');
    assert.equal(parseKey('\x1b[13u'), 'enter');
    assert.equal(parseKey('\x1b[13;2u'), 'shift+enter');
    assert.equal(parseKey('\x1b[27u'), 'escape');
    assert.equal(parseKey('\x1b[9u'), 'tab');
    assert.equal(parseKey('\x1b[127u'), 'backspace');
    assert.equal(parseKey('\x1b[1;5A'), 'ctrl+up');
    assert.equal(parseKey('\x1b[3;2~'), 'shift+delete');
  });

  it('xterm modifyOtherKeys', () => {
    assert.equal(parseKey('\x1b[27;2;13~'), 'shift+enter');
    assert.equal(parseKey('\x1b[27;5;99~'), 'ctrl+c');
  });
});

describe('matchesKey 与 parseKey 同口径', () => {
  const pairs: Array<[string, string]> = [
    ['\x1b[A', 'up'],
    ['\r', 'enter'],
    ['\x03', 'ctrl+c'],
    ['\x1b[Z', 'shift+tab'],
    ['\x1b', 'escape'],
    ['\x7f', 'backspace'],
    ['\x1b[99;5u', 'ctrl+c'],
    ['\x1b[13;2u', 'shift+enter'],
    ['a', 'a'],
  ];

  for (const [data, id] of pairs) {
    it(`${JSON.stringify(data)} 是 ${id}`, () => {
      assert.equal(parseKey(data), id);
      assert.equal(matchesKey(data, id as 'up'), true);
    });
  }

  it('Kitty 开启后 \\n 匹配 shift+enter，不匹配 enter', () => {
    setKittyProtocolActive(true);
    assert.equal(matchesKey('\n', 'shift+enter'), true);
    assert.equal(matchesKey('\n', 'enter'), false);
  });

  it('Kitty 关闭时 \\n 匹配 enter，不匹配 shift+enter', () => {
    assert.equal(matchesKey('\n', 'enter'), true);
    assert.equal(matchesKey('\n', 'shift+enter'), false);
  });

  it('修饰键顺序无关', () => {
    assert.equal(matchesKey('\x1b[100;6u', 'shift+ctrl+d'), true);
    assert.equal(matchesKey('\x1b[100;6u', 'ctrl+shift+d'), true);
  });

  it('遗留大写字母：parseKey 给字面量，matchesKey 只认 shift+a', () => {
    assert.equal(parseKey('A'), 'A');
    assert.equal(matchesKey('A', 'shift+a'), true);
    assert.equal(matchesKey('A', 'a'), false);
  });
});

describe('release / repeat / printable', () => {
  it('Kitty flag 2 的松开与重复', () => {
    assert.equal(isKeyRelease('\x1b[99;1:3u'), true);
    assert.equal(isKeyRepeat('\x1b[99;1:2u'), true);
    assert.equal(isKeyRelease('\x1b[99u'), false);
    assert.equal(isKeyRelease('\x1b[200~90:62:3F\x1b[201~'), false);
  });

  it('纯字母或 CSI-u 可打印字符', () => {
    assert.equal(decodePrintableKey('x'), undefined);
    assert.equal(decodePrintableKey('\x1b[120u'), 'x');
    assert.equal(decodePrintableKey('\x1b[99;5u'), undefined, 'ctrl 组合不是可打印插入');
  });
});
