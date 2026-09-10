/**
 * 把 TUI 里的选择写回 config.toml。
 *
 * 为什么不做「解析成对象 → 整体序列化重写」：config.toml 是用户手改的文件，带着成片注释
 * （当前那份 16 行里有 11 行注释）。整体重写会把注释、键顺序、未知键、对齐全部抹掉，
 * 等于把人家的配置文件变成生成物。这里只做外科手术式替换，三种情形分别处理：
 *   1. 命中未注释的同名键 → 只换值，行尾注释与前后空白原样保留；
 *   2. 只命中被注释掉的模板行（如 `# reasoning_effort = "medium"   # off | low | ...`）
 *      → 就地取消注释并换值，模板里的说明自动变成行尾注释；
 *   3. 都没有 → 追加到文件末尾。
 *
 * 写入用「临时文件 + rename」：rename 在同一文件系统上是原子的，写到一半失败也不会
 * 把用户的配置截断成半截。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type ConfigValue = string | number;

export interface SaveResult {
  path: string;
  /** 本次确保生效的键（值本来就相同也会列出——调用方据此说「已写入」）。 */
  keys: string[];
  /** 其中原本文件中不存在、被追加到末尾的键。 */
  added: string[];
}

export function updateConfigFile(path: string, patch: Readonly<Record<string, ConfigValue>>): SaveResult {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = original.endsWith('\n');
  const lines = original === '' ? [] : original.split(/\r?\n/);
  // split 会在结尾换行后多出一个空元素；append 前必须去掉，否则新增键顶上会多一个空行。
  if (endsWithNewline) lines.pop();

  const keys: string[] = [];
  const added: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const rendered = renderValue(value);
    const active = lines.findIndex((line) => isActiveKey(line, key));
    if (active >= 0) {
      lines[active] = replaceValue(lines[active], key, rendered);
      keys.push(key);
      continue;
    }
    const commented = lines.findIndex((line) => isCommentedKey(line, key));
    if (commented >= 0) {
      lines[commented] = activateCommented(lines[commented], key, rendered);
      keys.push(key);
      continue;
    }
    lines.push(`${key} = ${rendered}`);
    keys.push(key);
    added.push(key);
  }

  const text = `${lines.join(eol)}${eol}`;
  // 内容没变就不碰文件：避免无谓地改动 mtime（编辑器和同步工具会因此误报）。
  if (text !== original) writeAtomically(path, text);
  return { path, keys, added };
}

function writeAtomically(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, path);
}

/** `model = "x"` / `  model=1` 这类未注释的键行。 */
function isActiveKey(line: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line);
}

/** `# model = "x"` 这类被注释掉的模板行。 */
function isCommentedKey(line: string, key: string): boolean {
  return new RegExp(`^\\s*#\\s*${escapeRegExp(key)}\\s*=`).test(line);
}

function replaceValue(line: string, key: string, rendered: string): string {
  const match = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*=\\s*)(.*)$`).exec(line);
  if (!match) return line;
  return `${match[1]}${rendered}${trailingComment(match[2])}`;
}

/** 去掉注释符号后按同一套规则换值，于是模板里的说明自然成了新值的行尾注释。 */
function activateCommented(line: string, key: string, rendered: string): string {
  const match = /^(\s*)#\s*(.*)$/.exec(line);
  if (!match) return line;
  return replaceValue(`${match[1]}${match[2]}`, key, rendered);
}

/**
 * 取出值后面的行尾注释（含前导空白）。要跳过引号内的 `#`——
 * 路径、URL 里带 # 完全正常，不能当成注释起点。
 */
function trailingComment(text: string): string {
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote && ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === '#' && !inQuote) {
      const space = /\s*$/.exec(text.slice(0, i))?.[0] ?? '';
      return `${space === '' ? ' ' : space}${text.slice(i)}`;
    }
  }
  return '';
}

function renderValue(value: ConfigValue): string {
  if (typeof value === 'number') return String(value);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
