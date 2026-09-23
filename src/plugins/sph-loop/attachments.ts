/**
 * 用户消息里的 @ 文件提及。
 *
 * 输入框补全只负责把 `@路径` 写进文本；这里负责语义：提交时把提及的文件读出来
 * （文本内联、图片转 data URL），作为附件随 user 消息存储——存储保持用户原文，
 * 投影层（compact.pushSessionMessage）再把附件拼成模型可见的 `<attached-files>` 块。
 *
 * 解析刻意保守：只有「行首或空白后的 @」才算提及（邮箱 a@b.com、foo=@bar 都不触发），
 * 宁可漏、不要误把自然语言当文件读。解析规则独立于补全的触发规则（那是「输入中」的
 * 交互语义，这里是「提交后」的落盘语义），两处不必共享一套分隔符。
 */

import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { FileAttachment } from '../../session/types.js';
import {
  casefoldPath,
  IMAGE_BYTE_LIMIT,
  imageMime,
  looksLikeText,
  pathEscapes,
  READ_BYTE_LIMIT,
  readHead,
  splitCompleteUtf8,
  TEXT_SNIFF_BYTES,
} from '../../workspace/boundary.js';

/**
 * 从提交文本里解析出提及的路径（含 `@"含 空格"` 引号形式，未闭合引号兜底到行尾），
 * 按出现顺序去重。句尾标点（`@src/foo.ts,` 的逗号）不算文件名的一部分；
 * 真叫这种名字的文件用引号形式提及。
 */
export function parseFileMentions(text: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (path === '' || seen.has(path)) return;
    seen.add(path);
    mentions.push(path);
  };
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue;
    const prev = i === 0 ? '' : text[i - 1]!;
    if (!(prev === '' || prev === ' ' || prev === '\t' || prev === '\n')) continue;
    if (text[i + 1] === '"') {
      const close = text.indexOf('"', i + 2);
      const lineEnd = text.indexOf('\n', i + 2);
      const end = close !== -1 && (lineEnd === -1 || close < lineEnd)
        ? close
        : lineEnd === -1
        ? text.length
        : lineEnd;
      push(text.slice(i + 2, end));
      i = end;
      continue;
    }
    let end = i + 1;
    while (end < text.length && !/\s/.test(text[end]!)) end += 1;
    push(text.slice(i + 1, end).replace(/[.,;:!?)\]】」』、。，；：！？]+$/, ''));
    i = end - 1;
  }
  return mentions;
}

export interface CollectedMentions {
  attachments: FileAttachment[];
  /** 图片提及转成的 data URL，走既有 userImages 通道，不重复进 attachments。 */
  images: string[];
}

/**
 * 解析文本里的提及并读取文件。文本文件按 read_file 同一套上限截断（READ_BYTE_LIMIT，
 * UTF-8 边界安全）；图片转 data URL。提到目录、工作区外、二进制文件都生成带 error
 * 的占位条目——模型能据此向用户说明为什么内容没给到。
 */
export function collectFileMentions(text: string, workspaceRoot: string): CollectedMentions {
  const attachments: FileAttachment[] = [];
  const images: string[] = [];
  const seen = new Set<string>();
  for (const mention of parseFileMentions(text)) {
    // 补全写进来的路径统一是 / 分隔；resolve 在两个平台都能吃。
    const display = mention.replace(/\\/g, '/');
    const abs = resolve(workspaceRoot, display);
    const rel = relative(casefoldPath(resolve(workspaceRoot)), casefoldPath(abs));
    if (rel === '' || pathEscapes(rel)) {
      attachments.push({ path: display, error: 'path is outside the workspace' });
      continue;
    }
    // Windows 大小写不敏感：同一文件两种写法只读一次。
    const dedupeKey = casefoldPath(abs);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      attachments.push({ path: display, error: 'file not found' });
      continue;
    }
    if (stat.isDirectory()) {
      attachments.push({ path: display, error: 'is a directory (mention a file inside)' });
      continue;
    }
    const mime = imageMime(abs);
    if (mime !== undefined) {
      if (stat.size > IMAGE_BYTE_LIMIT) {
        attachments.push({ path: display, error: `image exceeds ${IMAGE_BYTE_LIMIT} bytes` });
        continue;
      }
      try {
        const data = readHead(abs, stat.size);
        images.push(`data:${mime};base64,${data.toString('base64')}`);
      } catch {
        attachments.push({ path: display, error: 'image is unreadable' });
      }
      continue;
    }
    try {
      const head = readHead(abs, READ_BYTE_LIMIT);
      if (!looksLikeText(abs, head.subarray(0, Math.min(TEXT_SNIFF_BYTES, head.length)))) {
        attachments.push({ path: display, error: 'binary file (content not inlined)' });
        continue;
      }
      attachments.push({
        path: display,
        content: splitCompleteUtf8(head).complete.toString('utf8'),
        ...(stat.size > READ_BYTE_LIMIT ? { totalBytes: stat.size } : {}),
      });
    } catch {
      attachments.push({ path: display, error: 'file is unreadable' });
    }
  }
  return { attachments, images };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 附件拼成追加在 user 正文之后的模型可见文本。占位条目（error）自闭合，
 * 让模型知道「用户提到了但拿不到」及其原因，而不是静默无视。
 */
export function attachmentWireSuffix(attachments: readonly FileAttachment[]): string {
  if (attachments.length === 0) return '';
  const blocks = attachments.map((attachment) => {
    if (attachment.error !== undefined) {
      return `<file path="${escapeAttr(attachment.path)}" error="${escapeAttr(attachment.error)}" />`;
    }
    const truncated = attachment.totalBytes !== undefined ? ` truncated-from="${attachment.totalBytes}"` : '';
    return `<file path="${escapeAttr(attachment.path)}"${truncated}>\n${attachment.content ?? ''}\n</file>`;
  });
  return `\n\n<attached-files>\n${blocks.join('\n')}\n</attached-files>`;
}
