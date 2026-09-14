/**
 * 行内代码 / 无语言围栏的 IDEA Darcula 近似着色。
 *
 * highlight.js 只处理带语言的围栏。Markdown `` `scanProject()` `` 整段走 codespan，
 * 不着色就会全是默认字。这里按 JetBrains Language Defaults（Darcula）做词法猜测：
 * 关键字橙、方法金、常量/字段紫、注解黄绿、字符串绿、数字蓝、其余默认字。
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

const TOKEN =
  /@[\w.]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d[\d.]*\b|\b[A-Za-z_]\w*\b|[()]|\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|[\s\S]/g;

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

/**
 * 给一段代码样文本按 Darcula 角色上色。树状图（含 ├└│）原样走 identifier，避免路径被拆碎。
 */
export function colorIdeaInline(text: string, colors: IdeaInlineColors): string {
  if (/[│├└─┬┤]/.test(text)) return colors.identifier(text);

  const parts: string[] = [];
  const matches = text.match(TOKEN);
  if (!matches) return colors.identifier(text);

  for (let index = 0; index < matches.length; index++) {
    const token = matches[index]!;
    if (token.startsWith('@')) {
      parts.push(colors.annotation(token));
      continue;
    }
    if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*')) {
      parts.push(colors.comment(token));
      continue;
    }
    if (token.startsWith('"') || token.startsWith("'")) {
      parts.push(colors.string(token));
      continue;
    }
    if (/^\d/.test(token)) {
      parts.push(colors.number(token));
      continue;
    }
    if (/^[A-Za-z_]/.test(token)) {
      if (JAVA_KEYWORDS.has(token)) {
        parts.push(colors.keyword(token));
        continue;
      }
      let look = index + 1;
      while (matches[look] === ' ' || matches[look] === '\t') look += 1;
      if (matches[look] === '(') {
        parts.push(colors.method(token));
        continue;
      }
      if (isConstant(token)) {
        parts.push(colors.constant(token));
        continue;
      }
      parts.push(colors.identifier(token));
      continue;
    }
    parts.push(colors.identifier(token));
  }
  return parts.join('');
}
