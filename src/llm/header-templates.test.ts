import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandHeaderTemplates } from './stream-client.js';

describe('expandHeaderTemplates', () => {
  it('{randN} 展开为指定长度的 base62 随机值', () => {
    const out = expandHeaderTemplates({ 'x-opencode-session': 'ses_{rand26}' });
    assert.match(out['x-opencode-session']!, /^ses_[A-Za-z0-9]{26}$/);
  });

  it('{ocid:*} 展开为 12 位 hex 时间片段 + 14 位 base62，共 26 字符', () => {
    const out = expandHeaderTemplates({
      ses: 'ses_{ocid:desc}',
      msg: 'msg_{ocid:asc}',
    });
    assert.match(out.ses!, /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    assert.match(out.msg!, /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
  });

  it('asc 时间片段随调用单调不减，desc 单调不增（同一毫秒靠计数器推进）', () => {
    const asc = Array.from({ length: 50 }, () => expandHeaderTemplates({ v: '{ocid:asc}' }).v!);
    for (let i = 1; i < asc.length; i++) {
      assert.ok(asc[i]!.slice(0, 12) >= asc[i - 1]!.slice(0, 12), `asc[${i}] 时间片段回退`);
    }
    const desc = Array.from({ length: 50 }, () => expandHeaderTemplates({ v: '{ocid:desc}' }).v!);
    for (let i = 1; i < desc.length; i++) {
      assert.ok(desc[i]!.slice(0, 12) <= desc[i - 1]!.slice(0, 12), `desc[${i}] 时间片段前跳`);
    }
  });

  it('无模板的值原样保留', () => {
    const out = expandHeaderTemplates({
      'User-Agent': 'opencode/1.18.31',
      'x-opencode-client': 'cli',
      authorization: 'Bearer {not-a-token}',
    });
    assert.equal(out['User-Agent'], 'opencode/1.18.31');
    assert.equal(out['x-opencode-client'], 'cli');
    // 只有完整的记号才展开，普通花括号文本不动。
    assert.equal(out.authorization, 'Bearer {not-a-token}');
  });

  it('每次调用取新值；一次展开多个记号', () => {
    const first = expandHeaderTemplates({
      a: '{rand8}',
      b: '{rand8}',
      c: 'x{rand4}y{rand4}z',
    });
    const second = expandHeaderTemplates({ a: '{rand8}', b: '{rand8}', c: 'x{rand4}y{rand4}z' });
    assert.notEqual(first.a, second.a);
    assert.notEqual(first.b, second.b);
    assert.match(first.a!, /^[A-Za-z0-9]{8}$/);
    assert.match(first.c!, /^x[A-Za-z0-9]{4}y[A-Za-z0-9]{4}z$/);
  });
});
