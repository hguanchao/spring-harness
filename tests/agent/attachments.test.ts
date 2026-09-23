import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attachmentWireSuffix, collectFileMentions, parseFileMentions } from '../../src/plugins/sph-loop/attachments.js';
import { READ_BYTE_LIMIT } from '../../src/workspace/boundary.js';

describe('parseFileMentions', () => {
  it('识别行首与空白后的 @token', () => {
    assert.deepEqual(parseFileMentions('@src/a.ts'), ['src/a.ts']);
    assert.deepEqual(parseFileMentions('看下 @src/a.ts 和 @tests/b.ts, 谢谢'), ['src/a.ts', 'tests/b.ts']);
    assert.deepEqual(parseFileMentions('第一行\n@b.ts'), ['b.ts']);
  });

  it('正文中间的 @ 不触发（邮箱、赋值）', () => {
    assert.deepEqual(parseFileMentions('联系 a@b.com'), []);
    assert.deepEqual(parseFileMentions('foo=@bar'), []);
  });

  it('支持引号路径，未闭合引号兜底到行尾', () => {
    assert.deepEqual(parseFileMentions('@"my file.ts" 后续'), ['my file.ts']);
    assert.deepEqual(parseFileMentions('@"my file.ts'), ['my file.ts']);
    assert.deepEqual(parseFileMentions('@"my file.ts"\n下一段 @b.ts'), ['my file.ts', 'b.ts']);
  });

  it('剥掉句尾标点并按出现顺序去重', () => {
    assert.deepEqual(parseFileMentions('@a.ts, @b.ts; 还有 @a.ts'), ['a.ts', 'b.ts']);
  });
});

describe('collectFileMentions', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sph-attach-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('文本文件内容内联进 attachments', () => {
    writeFileSync(join(root, 'a.txt'), 'hello');
    const { attachments, images } = collectFileMentions('读 @a.txt', root);
    assert.deepEqual(attachments, [{ path: 'a.txt', content: 'hello' }]);
    assert.deepEqual(images, []);
  });

  it('图片转 data URL 走 images 通道，不重复进 attachments', () => {
    writeFileSync(join(root, 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { attachments, images } = collectFileMentions('看 @x.png', root);
    assert.equal(images.length, 1);
    assert.match(images[0]!, /^data:image\/png;base64,/);
    assert.equal(attachments.length, 0);
  });

  it('缺失、目录、工作区外路径生成 error 占位而不是静默', () => {
    mkdirSync(join(root, 'sub'));
    const { attachments } = collectFileMentions('@missing.txt @sub @../outside.txt', root);
    assert.deepEqual(attachments, [
      { path: 'missing.txt', error: 'file not found' },
      { path: 'sub', error: 'is a directory (mention a file inside)' },
      { path: '../outside.txt', error: 'path is outside the workspace' },
    ]);
  });

  it('二进制文件不内联，给出占位说明', () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    const { attachments, images } = collectFileMentions('@blob.bin', root);
    assert.deepEqual(attachments, [{ path: 'blob.bin', error: 'binary file (content not inlined)' }]);
    assert.deepEqual(images, []);
  });

  it('超过单文件上限的文本被截断并记录原始大小', () => {
    writeFileSync(join(root, 'big.log'), 'x'.repeat(READ_BYTE_LIMIT + 10));
    const { attachments } = collectFileMentions('@big.log', root);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.content!.length, READ_BYTE_LIMIT);
    assert.equal(attachments[0]!.totalBytes, READ_BYTE_LIMIT + 10);
  });

  it('同一文件两种写法只读一次', () => {
    writeFileSync(join(root, 'a.ts'), '1');
    const { attachments } = collectFileMentions('@a.ts @./a.ts', root);
    assert.equal(attachments.length, 1);
  });

  it('指向工作区外的链接按越界拒绝，不把区外内容内联', (t) => {
    const outside = mkdtempSync(join(tmpdir(), 'sph-attach-out-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'super-secret');
      const linked = tryOutsideLink(outside, join(root, 'link'));
      if (!linked) {
        t.skip('本机不允许创建目录链接');
        return;
      }
      const { attachments } = collectFileMentions('@link/secret.txt', root);
      assert.deepEqual(attachments, [{ path: 'link/secret.txt', error: 'path is outside the workspace' }]);
      assert.equal(JSON.stringify(attachments).includes('super-secret'), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/** 目录链接：Windows 上 junction 不需要提权，失败再试 symlink。 */
function tryOutsideLink(outside: string, linkPath: string): boolean {
  for (const type of ['junction', 'dir', undefined] as const) {
    try {
      if (type === undefined) symlinkSync(outside, linkPath);
      else symlinkSync(outside, linkPath, type);
      return true;
    } catch {
      // 换下一种
    }
  }
  return false;
}

describe('attachmentWireSuffix', () => {
  it('把附件拼成 attached-files 块，占位条目自闭合', () => {
    const text = attachmentWireSuffix([
      { path: 'a.ts', content: 'const x = 1;' },
      { path: 'b.ts', error: 'file not found' },
      { path: 'c.ts', content: 'x', totalBytes: 500 },
    ]);
    assert.match(text, /\n\n<attached-files>\n/);
    assert.match(text, /<file path="a\.ts">\nconst x = 1;\n<\/file>/);
    assert.match(text, /<file path="b\.ts" error="file not found" \/>/);
    assert.match(text, /<file path="c\.ts" truncated-from="500">/);
  });

  it('路径里的引号被转义', () => {
    assert.match(attachmentWireSuffix([{ path: 'we"ird.ts', error: 'file not found' }]), /path="we&quot;ird\.ts"/);
  });

  it('无附件返回空串', () => {
    assert.equal(attachmentWireSuffix([]), '');
  });
});
