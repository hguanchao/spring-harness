/**
 * diff 行的语法高亮：按扩展名选语言，逐行 token 化成「片段 + 主题色名」。
 *
 * 分工与 grok 的 syntect 一致（见 diffPaint）：高亮只产出**前景色**片段，底色带由
 * 调用方独立铺，两层互不干扰。配色取自 grok 的 grok-night.tmTheme：关键字紫、
 * 函数蓝、常量橙、字符串橄榄绿、注释暗蓝灰（斜体）、运算符青。
 *
 * 引擎用 prismjs：同步、零 WASM，token 是结构化对象（不是 HTML），可以直接映射。
 * prism 核心是 CJS，语言组件按裸全局 `Prism` 取核心——Node 下用 createRequire
 * 加载并先挂到 globalThis。token 化按 (语言, 行) 缓存：渲染随宽度反复触发，
 * 折行每次都要重跑，token 结果与宽度无关。
 */
import { createRequire } from 'node:module';
import type { ThemeColor } from '@/plugins/sph-tui/theme/palettes.js';

/** 一个可见片段：text 原文；color = 'text' 表示不上色（裸文本，保证行首缩进可被精确识别）。 */
export interface SyntaxSpan {
  text: string;
  color: ThemeColor;
  italic?: boolean;
}

type PrismToken = { type: string; content: string | PrismToken[] };
type PrismNs = {
  languages: Record<string, unknown>;
  tokenize(code: string, grammar: unknown): (string | PrismToken)[];
};

const require = createRequire(import.meta.url);
const prism = require('prismjs') as PrismNs;
(globalThis as unknown as { Prism: unknown }).Prism = prism;
// 依赖顺序：typescript 依赖 javascript（核心自带），tsx 依赖 jsx + typescript，cpp 依赖 c。
for (const lang of ['typescript', 'jsx', 'tsx', 'python', 'json', 'bash', 'java', 'c', 'cpp', 'go', 'rust', 'sql', 'yaml']) {
  require(`prismjs/components/prism-${lang}`);
}

const EXT_LANGUAGES: Record<string, string> = {
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  go: 'go', rs: 'rust', sql: 'sql', yml: 'yaml', yaml: 'yaml',
};

/** 文件路径 → prism 语言名。取最后一段扩展名；无扩展名或没收录的返回 undefined（不上色）。 */
export function languageForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_LANGUAGES[path.slice(dot + 1).toLowerCase()];
}

/**
 * 统一 diff 的语言：从 `+++ b/路径`（退化到 `diff --git a/… b/路径`）里取新文件扩展名。
 * 新文件是 /dev/null（纯删除）时从 `diff --git` 行兜底。
 */
export function languageForDiffHeader(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(0, 20)) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    const path = plus?.[1]?.trim();
    if (path && path !== '/dev/null') return languageForPath(path);
  }
  for (const line of lines.slice(0, 20)) {
    const git = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (git) return languageForPath(git[1]!.trim());
  }
  return undefined;
}

/** prism token 类型（可能带空格别名，如 "class-name maybe-class-name"）→ 主题色名。 */
function roleFor(type: string): ThemeColor {
  for (const part of type.split(/\s+/)) {
    if (/^(comment|prolog|shebang|doctype|cdata)/.test(part)) return 'syntaxComment';
    if (/^(string|char|template-string|multiline|docstring)/.test(part)) return 'syntaxString';
    if (/^(keyword|storage)/.test(part)) return 'syntaxKeyword';
    if (/^(boolean|null|constant|number)/.test(part)) return 'syntaxConstant';
    if (/^(builtin|function|method)/.test(part)) return 'syntaxFunction';
    if (/^(class-name|type|annotation|decorator|preprocessor)/.test(part)) return 'syntaxType';
    if (/^(operator|escape|regex|important|entity)/.test(part)) return 'syntaxOperator';
  }
  return 'text';
}

const spanCache = new Map<string, SyntaxSpan[]>();
const SPAN_CACHE_LIMIT = 8_192;

function walk(tokens: (string | PrismToken)[], spans: SyntaxSpan[], inherited: ThemeColor = 'text'): void {
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (token !== '') spans.push({ text: token, color: inherited });
      continue;
    }
    const color = roleFor(token.type);
    if (typeof token.content === 'string') {
      if (token.content === '') continue;
      spans.push({ text: token.content, color: color === 'text' ? inherited : color, italic: color === 'syntaxComment' || undefined });
    } else {
      // 嵌套 token（f-string 内插、带引号的字符串等）：子级有自己的角色就用它，
      // 否则继承父级——"hi" 整段保持字符串色，不会掉回正文白。
      walk(token.content, spans, color === 'text' ? inherited : color);
    }
  }
}

/** 一行源码 → 着色片段序列（拼接回来恒等于原文）。未知语言/空行返回单段裸文本。 */
export function syntaxSpans(line: string, lang: string): SyntaxSpan[] {
  if (line === '' || !prism.languages[lang]) return [{ text: line, color: 'text' }];
  const key = `${lang}\u0000${line}`;
  const hit = spanCache.get(key);
  if (hit) return hit;
  const spans: SyntaxSpan[] = [];
  walk(prism.tokenize(line, prism.languages[lang]), spans);
  if (spans.length === 0) spans.push({ text: line, color: 'text' });
  if (spanCache.size >= SPAN_CACHE_LIMIT) spanCache.clear();
  spanCache.set(key, spans);
  return spans;
}
