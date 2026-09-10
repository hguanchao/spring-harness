/**
 * 代码块语法高亮：**有状态逐行扫描器**，不引 tree-sitter。
 *
 * 为什么自己写而不是引库：
 * - tree-sitter 需要 wasm + 远程下载解析器与查询文件（见参考实现 parsers-config 里的
 *   GitHub raw URL），既要求特殊运行时，又是运行时联网抓取 —— 与本项目既有原则冲突。
 * - highlight.js / shiki 会带来一棵依赖树，而我们需要的高亮强度远低于它们的完整能力。
 * - 真正难的不是「认出关键字」，而是**跨行状态**（多行注释、模板串、Python 三引号）
 *   与**每行样式自洽**。前者一个状态机就够，后者由 markdown 的 span 流天然满足。
 *
 * 覆盖范围刻意收窄到「模型最常输出的语言」：TS/JS 家族、JSON、Python、shell、diff。
 * 其余语言返回 undefined，走纯文本 —— **高亮失败必须安全降级，绝不抛错**（代码内容
 * 可能是任意语言甚至不是代码）。
 */

import type { LineHighlighter, Span, Tone } from './markdown.js';

interface LangSpec {
  lineComments: readonly string[];
  block?: readonly [string, string];
  quotes: readonly string[];
  /** 可跨行的三引号串（Python）等。 */
  triples?: readonly string[];
  keywords: ReadonlySet<string>;
  types?: ReadonlySet<string>;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/));

const TS_KEYWORDS = words(`
  abstract as async await break case catch class const constructor continue declare default delete do
  else enum export extends false finally for from function get if implements import in instanceof
  interface is keyof let new null of readonly return satisfies set static super switch this throw true
  try type typeof undefined var void while with yield
`);
const TS_TYPES = words(`
  any bigint boolean never number object string symbol unknown Array Boolean Date Error Map Number Object
  Promise Record RegExp Set String Symbol WeakMap WeakSet
`);

const PY_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except finally for from global if
  import in is lambda nonlocal not or pass raise return try while with yield True False None self cls
`);
const PY_TYPES = words('int float str bytes bool list dict set tuple object type Exception ValueError');

const SHELL_KEYWORDS = words(`
  if then else elif fi for while do done case esac function return export local readonly set unset
  shift source alias echo cd exit trap eval exec test
`);

const SPECS: Readonly<Record<string, LangSpec>> = {
  ts: {
    lineComments: ['//'],
    block: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    keywords: TS_KEYWORDS,
    types: TS_TYPES,
  },
  json: { lineComments: [], quotes: ['"'], keywords: words('true false null') },
  python: {
    lineComments: ['#'],
    quotes: ['"', "'"],
    triples: ['"""', "'''"],
    keywords: PY_KEYWORDS,
    types: PY_TYPES,
  },
  bash: {
    lineComments: ['#'],
    quotes: ['"', "'"],
    keywords: SHELL_KEYWORDS,
  },
};

const ALIASES: Readonly<Record<string, string>> = {
  tsx: 'ts',
  ts: 'ts',
  typescript: 'ts',
  js: 'ts',
  jsx: 'ts',
  javascript: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  diff: 'diff',
  patch: 'diff',
};

const IDENT = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)/;
const OPERATOR = /^(?:[+\-*/%=<>!&|^~?:]+|\.\.\.)/;

/** 单行长度上限：超长的「代码」多半是数据转储，逐字符扫描不值得。 */
const MAX_SCAN = 2000;

class Scanner implements LineHighlighter {
  private inBlock = false;
  private inTriple: string | null = null;

  constructor(private readonly spec: LangSpec) {}

  line(text: string): Span[] {
    if (text.length > MAX_SCAN) return [{ text }];
    const out: Span[] = [];
    let plain = '';
    const push = (kind: Tone, value: string): void => {
      if (value === '') return;
      if (kind === 'plain') {
        plain += value;
        return;
      }
      if (plain !== '') {
        out.push({ text: plain });
        plain = '';
      }
      out.push({ text: value, tone: kind });
    };

    let i = 0;
    // 上一行遗留的跨行状态优先收尾。
    if (this.inBlock && this.spec.block) {
      const close = text.indexOf(this.spec.block[1]);
      const end = close === -1 ? text.length : close + this.spec.block[1].length;
      push('comment', text.slice(0, end));
      if (close === -1) return out;
      this.inBlock = false;
      i = end;
    } else if (this.inTriple) {
      const close = text.indexOf(this.inTriple);
      const end = close === -1 ? text.length : close + this.inTriple.length;
      push('string', text.slice(0, end));
      if (close === -1) return out;
      this.inTriple = null;
      i = end;
    }

    while (i < text.length) {
      const rest = text.slice(i);
      const ch = text[i]!;

      if (ch === ' ' || ch === '\t') {
        push('plain', ch);
        i++;
        continue;
      }

      const lineComment = this.spec.lineComments.find((c) => rest.startsWith(c));
      if (lineComment !== undefined) {
        push('comment', rest);
        break;
      }

      if (this.spec.block && rest.startsWith(this.spec.block[0])) {
        const close = text.indexOf(this.spec.block[1], i + this.spec.block[0].length);
        if (close === -1) {
          push('comment', rest);
          this.inBlock = true;
          break;
        }
        const end = close + this.spec.block[1].length;
        push('comment', text.slice(i, end));
        i = end;
        continue;
      }

      const triple = this.spec.triples?.find((t) => rest.startsWith(t));
      if (triple !== undefined) {
        const close = text.indexOf(triple, i + triple.length);
        if (close === -1) {
          push('string', rest);
          this.inTriple = triple;
          break;
        }
        const end = close + triple.length;
        push('string', text.slice(i, end));
        i = end;
        continue;
      }

      if (this.spec.quotes.includes(ch)) {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === '\\') {
            j += 2;
            continue;
          }
          if (text[j] === ch) break;
          j++;
        }
        const end = Math.min(j + 1, text.length);
        push('string', text.slice(i, end));
        i = end;
        continue;
      }

      if (/[0-9]/.test(ch)) {
        const m = NUMBER.exec(rest);
        if (m) {
          push('number', m[0]);
          i += m[0].length;
          continue;
        }
      }

      const ident = IDENT.exec(rest);
      if (ident) {
        const word = ident[0];
        if (this.spec.keywords.has(word)) push('keyword', word);
        else if (this.spec.types?.has(word)) push('type', word);
        // 后面紧跟 `(` 的标识符按函数名处理；`function foo` 由关键字分支兜住。
        else if (/^\s*\(/.test(text.slice(i + word.length))) push('function', word);
        else push('plain', word);
        i += word.length;
        continue;
      }

      const op = OPERATOR.exec(rest);
      if (op) {
        push('operator', op[0]);
        i += op[0].length;
        continue;
      }

      push('plain', ch);
      i++;
    }

    if (plain !== '') out.push({ text: plain });
    return out;
  }
}

/** diff / patch：按行首标记着色，不逐字符扫描。 */
class DiffScanner implements LineHighlighter {
  line(text: string): Span[] {
    if (/^(?:\+\+\+|---|diff |index |@@)/.test(text)) return [{ text, tone: 'meta' }];
    if (text.startsWith('+')) return [{ text, tone: 'added' }];
    if (text.startsWith('-')) return [{ text, tone: 'removed' }];
    return [{ text }];
  }
}

/**
 * 按语言名创建着色器；未知语言返回 undefined（调用方按纯文本渲染）。
 * 每次调用返回新实例 —— 跨行状态属于单个代码块，不能跨块泄漏。
 */
export function createHighlighter(lang: string): LineHighlighter | undefined {
  const key = ALIASES[lang.trim().toLowerCase()];
  if (key === undefined) return undefined;
  if (key === 'diff') return new DiffScanner();
  const spec = SPECS[key];
  return spec ? new Scanner(spec) : undefined;
}
