/**
 * 斜杠命令注册表与弹窗列宽工具。
 *
 * 命令的「注册」与「实现」分离：这里只放命令名、菜单文案与别名；实现分散在
 * interactive-mode.ts（与轮次/状态紧耦合的命令）与 *-commands.ts（按域拆出的命令）。
 * 注册表是单一事实来源：/help、Ctrl+P 命令面板、编辑器补全都从这里取数。
 */

import { visibleWidth } from './screen/utils.js';
import type { SelectItem } from './screen/index.js';

export interface CommandItem {
  id: string;
  label: string;
  hint: string;
}

export const COMMANDS: readonly CommandItem[] = [
  { id: 'help', label: '/help', hint: 'List commands and key bindings' },
  { id: 'history', label: '/history', hint: 'Search and reuse prompt history' },
  { id: 'new', label: '/new', hint: 'Start a new session' },
  { id: 'resume', label: '/resume', hint: 'Resume a previous session, or switch by id' },
  { id: 'skills', label: '/skills', hint: 'List the skills this workspace advertises' },
  { id: 'mcps', label: '/mcps', hint: 'Manage MCP servers: status, enable/disable, add, remove, reload' },
  { id: 'plan', label: '/plan', hint: 'Enter plan mode, or /plan off to leave' },
  { id: 'goal', label: '/goal', hint: 'Set, view, or clear the goal' },
  { id: 'compact', label: '/compact', hint: 'Compact older history into a checkpoint, optionally with focus instructions' },
  { id: 'model', label: '/model', hint: 'Choose a model and write it to config.toml' },
  { id: 'provider', label: '/provider', hint: 'Switch provider, then model, reasoning effort, and API protocol' },
  { id: 'effort', label: '/effort', hint: 'Set reasoning effort (written to config.toml)' },
  { id: 'permission', label: '/permission', hint: 'Set the approval mode: ask | auto | yolo' },
  { id: 'export', label: '/export', hint: 'Export this session as markdown, json, or html' },
];

/**
 * 别名 → 正名。正名进菜单（`/help`、Ctrl+P 命令面板），别名只保证还能敲。
 *
 * 这条分工照抄 grok-build：那边的 `/resume` 是会话选择器的正名，`/sessions` 留作
 * 老习惯的重定向。sph 早先只有 `/sessions`，名字留下是因为肌肉记忆和已经写进会话
 * 记录的文本里都是它；新名字与 CLI 的 `sph --resume` 对齐。
 */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = { sessions: 'resume' };

/** 选择列表里 server 条目的 value 前缀，避免和上方的固定动作条目撞名。 */
export const SERVER_PREFIX = 'server:';

export const COMMAND_NAMES = new Set<string>([
  ...COMMANDS.map((command) => command.id),
  ...Object.keys(COMMAND_ALIASES),
]);

/**
 * 斜杠命令弹窗的主列（label 列）宽度：最宽 label + 2 列间隙，下限 8。
 *
 * SelectList 默认 32 列是给「命令表 + 长提示」这类排版用的；对 label 很短的菜单
 * （ask / yolo / effort 档位）会让 description 拖出一大段空白。统一自适应后各弹窗
 * 的列都贴内容，视觉一致。
 */
export function primaryColumnWidthFor(items: readonly SelectItem[]): number {
  const widest = items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0);
  return Math.max(widest, 8) + 2;
}
