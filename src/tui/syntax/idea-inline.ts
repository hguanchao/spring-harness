/**
 * 行内代码 / 无语言围栏的 IDEA Darcula 近似着色。
 *
 * highlight.js 只处理带语言的围栏。Markdown `` `scanProject()` `` 整段走 codespan，
 * 不着色就会全是默认字。这里按 JetBrains Language Defaults（Darcula）做词法猜测：
 * 关键字橙、注解金、字符串绿；方法/数字/常量/其余标识符同为行内蓝，不高亮过满。
 *
 * 来源：IntelliJ 预置方案 Darcula（Editor | Color Scheme | Language Defaults），
 * 官方说明见 https://www.jetbrains.com/help/idea/configuring-colors-and-fonts.html
 */

const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'true',
  'false',
  'null',
  'var',
  'record',
  'sealed',
  'permits',
  'yield',
]);

/**
 * 跨语言的高辨识度关键字。
 *
 * 只收「不是普通英文词、也极少作标识符」的词。`from` / `type` / `as` / `in` / `is` / `local` /
 * `done` / `module` / `export` / `object` / `range` / `map` / `join` / `update` / `end` / `then`
 * 这类与英文同形的关键字**一律不收**——实测在本仓语料里它们 100% 出现在标识符或英文散文里
 * （`Install Plugin from Disk`、`action.export|export.postman`、`local/http://…`、
 * `notification.scan.done=扫描完成`、`String.join(", ")`），收进来只会制造误判。
 *
 * 换言之：多语言支持靠「高辨识度词表」，不靠「把各语言关键字取并集」。
 */
const DISTINCT_KEYWORDS = new Set([
  // Python
  'def',
  'elif',
  'lambda',
  'None',
  'True',
  'False',
  'nonlocal',
  'except',
  'raise',
  // Go
  'func',
  'chan',
  'defer',
  'nil',
  // Rust
  'fn',
  'impl',
  'trait',
  'crate',
  'mut',
  'dyn',
  'pub',
  'unsafe',
  // TypeScript / JavaScript
  'readonly',
  'keyof',
  'infer',
  'satisfies',
  'undefined',
  'NaN',
  'typeof',
  // Shell
  'fi',
  'esac',
  // Kotlin / Scala
  'fun',
  'val',
  // C / C++ / C#
  'typedef',
  'sizeof',
  'nullptr',
  'namespace',
  'struct',
  'extern',
  // Ruby
  'elsif',
  'attr_accessor',
]);

/** 段首的 C 预处理器指令：按「元信息」上色，而不是被 `#` 规则误判成注释。 */
const PREPROCESSOR = /^#\s*(?:include|define|ifdef|ifndef|endif|pragma|undef|error|line|elif|else)\b/;

/** `# 注释` / `#!/bin/bash` / 单个 `#`：只有这几种形态才算注释。 */
const HASH_COMMENT = /^#\s|^#!|^#$/;

/** 上色用的关键字全集：Java/通用 C 家族 + 跨语言高辨识度词。 */
const ALL_KEYWORDS = new Set([...JAVA_KEYWORDS, ...DISTINCT_KEYWORDS]);

/**
 * `//` 只有「行首」或「紧跟语句结束符」才算行注释。
 * `http://x`（前一位是 `:`）、`a // b`（前一位是标识符）都不算。
 */
const STATEMENT_END = new Set([';', '{', '}', ')', ',']);

/** 前一位（跳过行内空白）是否落在行首。 */
function atLineStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
  return i < 0 || text[i] === '\n';
}

function lineCommentStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
  if (i < 0 || text[i] === '\n') return true;
  return STATEMENT_END.has(text[i]!);
}

/** 制表符正则带 `m`：`//` / `#` 的 `.*$` 按行收尾，多行行内码也不会吞掉后续内容。 */
const TOKEN =
  /@[\w.]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d[\d.]*\b|\b[A-Za-z_]\w*\b|[()]|\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|[\s\S]/gm;

/** 树状图/表格的制表符：整行按普通文本处理，避免路径被拆成「方法名 + 括号」。 */
const BOX_DRAWING = /[│┃┆┇┊┋├┤┬┴┼╭╮╯╰━┄┈╌─]/;

export interface IdeaInlineColors {
  keyword: (text: string) => string;
  method: (text: string) => string;
  constant: (text: string) => string;
  annotation: (text: string) => string;
  string: (text: string) => string;
  number: (text: string) => string;
  comment: (text: string) => string;
  identifier: (text: string) => string;
}

function isConstant(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1;
}

/** 词法角色。`plain` 与 `identifier` 同色，分开只是为了表达「没判断出来」。 */
type Role = 'keyword' | 'method' | 'constant' | 'annotation' | 'string' | 'number' | 'comment' | 'meta' | 'plain';

interface Piece {
  role: Role;
  text: string;
}

/**
 * 给一段代码样文本按 Darcula 角色上色。
 *
 * 三条与「朴素正则猜色」不同的取舍：
 * 1. **注释要判位置**。`//` 和 `#` 不是见到就算注释——`http://x`、`Class#method`、
 *    `color: #ffc66d`、`### 标题` 在真实语料里全都出现过，朴素规则会把它们后面整段染灰。
 * 2. **紧跟 `=` 的关键字是配置项名，不是关键字**（`class=RefreshEndpointsAction`）。
 * 3. **树状图整行不上色**，避免 `├── model/  HttpMethod` 里的路径被拆成「方法名 + 括号」。
 *
 * 方法调用的括号与方法名同色：`foo(` 被劈成「蓝名字 + 另一色括号」两截时，
 * 看起来像两个不相干的 token，而它本来是一个调用。
 *
 * 注意：这里**没有**做「整段证据门槛」。曾试过「单个关键字且无其他代码特征就不上色」，
 * 在 1013 条真实行内码上拦下 43 个，逐条核对只有 9 个拦对（`class=xxx` 配置项、
 * `module→class→request` 这类名词），34 个拦错（`extends X`、`implements X`、
 * `instanceof X`、`new Panel`、`caching=true` 这些标准代码形态）——净负收益，故不做。
 */
export function colorIdeaInline(text: string, colors: IdeaInlineColors): string {
  if (BOX_DRAWING.test(text)) return colors.identifier(text);

  const matches = [...text.matchAll(TOKEN)];
  if (matches.length === 0) return colors.identifier(text);

  const pieces: Piece[] = [];
  /** 属于方法调用的左括号下标：由方法名的前瞻（跳过空白后是 `(`）确定。 */
  const callParens = new Set<number>();
  /** 每个已输出的左括号是否属于方法调用，用来配对它的右括号。 */
  const parenStack: boolean[] = [];

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const token = match[0]!;
    const at = match.index!;

    // 括号先处理：它们的颜色取决于刚才那个名字是不是方法调用。
    if (token === '(' || token === ')') {
      const isCall = token === '(' ? callParens.has(index) : parenStack.pop() === true;
      if (token === '(') parenStack.push(isCall);
      pieces.push({ role: isCall ? 'method' : 'plain', text: token });
      continue;
    }

    if (token.startsWith('@')) {
      pieces.push({ role: 'annotation', text: token });
      continue;
    }

    if (token.startsWith('/*')) {
      pieces.push({ role: 'comment', text: token });
      continue;
    }

    if (token.startsWith('//')) {
      pieces.push({ role: lineCommentStart(text, at) ? 'comment' : 'plain', text: token });
      continue;
    }

    if (token.startsWith('#')) {
      // `#` 只在一行开头有意义；`Class#method`、`color: #ffc66d` 一律按普通字符走。
      if (!atLineStart(text, at)) {
        pieces.push({ role: 'plain', text: token });
        continue;
      }
      if (PREPROCESSOR.test(token)) {
        pieces.push({ role: 'meta', text: token });
        continue;
      }
      pieces.push({ role: HASH_COMMENT.test(token) ? 'comment' : 'plain', text: token });
      continue;
    }

    if (token.startsWith('"') || token.startsWith("'")) {
      pieces.push({ role: 'string', text: token });
      continue;
    }

    if (/^\d/.test(token)) {
      pieces.push({ role: 'number', text: token });
      continue;
    }

    if (/^[A-Za-z_]/.test(token)) {
      // `key=value` 里的 `key` 是配置项名（`class=RefreshEndpointsAction`），不是关键字。
      if (ALL_KEYWORDS.has(token) && text[at + token.length] !== '=') {
        pieces.push({ role: 'keyword', text: token });
        continue;
      }
      let look = index + 1;
      while (look < matches.length && /^\s+$/.test(matches[look]![0])) look += 1;
      if (matches[look]?.[0] === '(') {
        callParens.add(look);
        pieces.push({ role: 'method', text: token });
        continue;
      }
      if (isConstant(token)) {
        pieces.push({ role: 'constant', text: token });
        continue;
      }
      pieces.push({ role: 'plain', text: token });
      continue;
    }

    pieces.push({ role: 'plain', text: token });
  }

  return pieces
    .map((piece) => {
      if (piece.role === 'meta') return colors.annotation(piece.text);
      if (piece.role === 'plain') return colors.identifier(piece.text);
      return colors[piece.role](piece.text);
    })
    .join('');
}
