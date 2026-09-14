/**
 * 代码语法高亮。
 *
 * 参考实现 pi 用 highlight.js（core + 预注册语言）产出 HTML，再把 <span class="hljs-*">
 * 按作用域映射成 ANSI 样式。这里保持一致的做法，只是主题格式化器由调用方注入，
 * 避免 syntax → theme 的循环依赖。
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import groovy from "highlight.js/lib/languages/groovy";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nix from "highlight.js/lib/languages/nix";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages: Record<string, unknown> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  go,
  groovy,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nix,
  perl,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  scala,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language);
}

/** 常见别名，便于围栏代码块里写 js/ts/sh/py 等短名。 */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  yml: 'yaml',
  toml: 'ini',
  html: 'xml',
  htm: 'xml',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  jsonc: 'json',
  json5: 'json',
  docker: 'dockerfile',
  golang: 'go',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
};

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
  language?: string;
  ignoreIllegals?: boolean;
  languageSubset?: string[];
  theme?: HighlightTheme;
}

const SPAN_CLOSE = '</span>';
const HIGHLIGHT_CLASS_PREFIX = 'hljs-';

function getScopeFromSpanTag(tag: string): string | undefined {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const classValue = match?.[1] ?? match?.[2];
  if (!classValue) return undefined;
  const classes = classValue.split(/\s+/);
  // highlight.js v11 把 `title.function` / `title.class` 拆成 `hljs-title` + `function_` / `class_`。
  // 后者更细，先认它，否则函数名和类名都会落到同一个 title 作用域。
  if (classes.includes('class_')) return 'class';
  if (classes.includes('function_')) return 'function';
  for (const className of classes) {
    if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
  }
  return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
  const exact = theme[scope];
  if (exact) return exact;
  const dotIndex = scope.indexOf('.');
  if (dotIndex !== -1) {
    const prefixFormatter = theme[scope.slice(0, dotIndex)];
    if (prefixFormatter) return prefixFormatter;
  }
  const dashIndex = scope.indexOf('-');
  if (dashIndex !== -1) {
    const prefixFormatter = theme[scope.slice(0, dashIndex)];
    if (prefixFormatter) return prefixFormatter;
  }
  return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope) continue;
    const formatter = getScopeFormatter(scope, theme);
    if (formatter) return formatter;
  }
  return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
  if (!html.startsWith('<span', index)) return false;
  const nextChar = html[index + '<span'.length];
  return nextChar === '>' || nextChar === ' ' || nextChar === '\t' || nextChar === '\n' || nextChar === '\r';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 解码 highlight.js 输出里的 HTML 实体；无法识别时返回 undefined。 */
function decodeHtmlEntityAt(text: string, index: number): { text: string; length: number } | undefined {
  if (text[index] !== '&') return undefined;
  const semicolon = text.indexOf(';', index + 1);
  if (semicolon === -1 || semicolon - index > 10) return undefined;
  const body = text.slice(index + 1, semicolon);
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const code = Number.parseInt(body.slice(2), 16);
    if (Number.isNaN(code)) return undefined;
    return { text: String.fromCodePoint(code), length: semicolon - index + 1 };
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10);
    if (Number.isNaN(code)) return undefined;
    return { text: String.fromCodePoint(code), length: semicolon - index + 1 };
  }
  const named = NAMED_ENTITIES[body];
  if (named === undefined) return undefined;
  return { text: named, length: semicolon - index + 1 };
}

/** 把 highlight.js 的 HTML 输出按作用域映射为带 ANSI 样式的纯文本。 */
export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
  let output = '';
  let textBuffer = '';
  const scopes: Array<string | undefined> = [];

  const flushText = (): void => {
    if (!textBuffer) return;
    const formatter = getActiveFormatter(scopes, theme);
    output += formatter ? formatter(textBuffer) : textBuffer;
    textBuffer = '';
  };

  let index = 0;
  while (index < html.length) {
    if (isSpanOpenTagStart(html, index)) {
      const tagEndIndex = html.indexOf('>', index + 5);
      if (tagEndIndex !== -1) {
        flushText();
        const tag = html.slice(index, tagEndIndex + 1);
        scopes.push(getScopeFromSpanTag(tag));
        index = tagEndIndex + 1;
        continue;
      }
    }
    if (html.startsWith(SPAN_CLOSE, index)) {
      flushText();
      if (scopes.length > 0) scopes.pop();
      index += SPAN_CLOSE.length;
      continue;
    }
    if (html[index] === '&') {
      const decoded = decodeHtmlEntityAt(html, index);
      if (decoded) {
        textBuffer += decoded.text;
        index += decoded.length;
        continue;
      }
    }
    textBuffer += html[index];
    index++;
  }

  flushText();
  return output;
}

/** 语言名归一化：别名与大小写都收敛到已注册的名字。 */
export function normalizeLanguage(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.trim().toLowerCase();
  const canonical = ALIASES[lower] ?? lower;
  return hljs.getLanguage(canonical) ? canonical : undefined;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
  const language = normalizeLanguage(options.language);
  const html = language
    ? hljs.highlight(code, { language, ignoreIllegals: options.ignoreIllegals }).value
    : hljs.highlightAuto(code, options.languageSubset).value;
  return renderHighlightedHtml(html, options.theme);
}
