/**
 * TUI 模块公共入口。
 *
 * 分层与参考实现 pi 对齐：
 *   - core/       —— 通用终端 UI 框架（差分渲染、布局、组件、键位、编辑器、Markdown…）
 *   - theme/      —— 命名色板与组件主题
 *   - syntax/     —— 代码高亮
 *   - components/ —— 应用组件（消息块、工具块、底栏、编辑器外壳…）
 *   - interactive-mode.ts —— 交互模式装配与调度
 */

export { runTui, type TuiDeps } from './interactive-mode.js';
export { confirmWorkspaceTrust } from './trust.js';

// 框架与主题的常用导出，方便测试与其他呈现层复用。
export * from './core/index.js';
export {
  getEditorTheme,
  getMarkdownTheme,
  getSelectListTheme,
  highlightCode,
  theme,
  Theme,
  type ThemeColor,
} from './theme/theme.js';
export { AssistantMessageComponent } from './components/assistant-message.js';
export { UserMessageComponent } from './components/user-message.js';
export { ToolExecutionComponent } from './components/tool-execution.js';
export { FooterComponent, formatTokens } from './components/footer.js';
export { HeaderComponent } from './components/header.js';
export { DynamicBorder } from './components/interaction.js';
