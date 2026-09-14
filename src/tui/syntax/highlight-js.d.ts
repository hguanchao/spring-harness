/**
 * highlight.js 的最小类型声明。
 *
 * highlight.js 只为入口提供类型，`lib/core.js` 与 `lib/languages/*.js` 这些深层入口没有
 * 随包类型；参考实现也是用一份本地 .d.ts 兜住。
 */
declare module "highlight.js/lib/core" {
  interface HighlightResult {
    value: string;
    language?: string;
    relevance: number;
  }
  interface Hljs {
    registerLanguage(name: string, language: unknown): void;
    getLanguage(name: string): unknown;
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
    highlightAuto(code: string, languageSubset?: string[]): HighlightResult;
  }
  const hljs: Hljs;
  export default hljs;
}

declare module "highlight.js/lib/languages/*" {
  const language: unknown;
  export default language;
}
