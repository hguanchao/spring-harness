import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitCompleteUtf8 } from '../../src/tools/read-file.js';

describe('splitCompleteUtf8', () => {
  it('完整 ASCII 与完整汉字都整段留下', () => {
    const ascii = Buffer.from('abc');
    assert.deepEqual(splitCompleteUtf8(ascii).complete, ascii);
    assert.equal(splitCompleteUtf8(ascii).rest.length, 0);
    const han = Buffer.from('中');
    assert.deepEqual(splitCompleteUtf8(han).complete, han);
    assert.equal(splitCompleteUtf8(han).rest.length, 0);
  });

  it('块尾劈开的三字节汉字留给下一块', () => {
    const han = Buffer.from('中');
    const prefix = Buffer.from('ab');
    const cut = Buffer.concat([prefix, han.subarray(0, 2)]);
    const { complete, rest } = splitCompleteUtf8(cut);
    assert.equal(complete.toString('utf8'), 'ab');
    assert.deepEqual(rest, han.subarray(0, 2));
    const joined = splitCompleteUtf8(Buffer.concat([rest, han.subarray(2)]));
    assert.equal(joined.complete.toString('utf8'), '中');
    assert.equal(joined.rest.length, 0);
  });
});
