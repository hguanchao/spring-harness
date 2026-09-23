/**
 * 会话类命令域：/history、/new、/resume（别名 /sessions）、/export。
 *
 * 弹窗交互 + 会话文件操作；换会话的落地（锁切换、状态复位、回放）收口到宿主回调，
 * 命令层不直接改交互模式的字段。
 */

import { flattenWhitespace } from '../../util.js';
import type { SessionPort } from '../../session/types.js';
import { EMPTY_PLUGIN_SERVICES } from '../types.js';
import { SESSION_SERVICE, type SessionService } from '../services.js';
import { sessionService } from '../sph-session/index.js';
import { primaryColumnWidthFor } from './commands.js';
import type { CustomEditor } from './components/custom-editor.js';
import type { TuiDeps } from './deps.js';
import { showConfirmDialog, showMessageDialog, showSelectDialog } from './dialogs.js';
import type { TUI, SelectItem } from './screen/index.js';

/** 替换插件优先；没装载时用内置 JSONL，避免界面在测试装配里变成空列表。 */
function sessionsOf(deps: TuiDeps): SessionService | undefined {
  const found = deps.pluginServices.get<SessionService>(SESSION_SERVICE);
  if (found) return found;
  return deps.pluginServices === EMPTY_PLUGIN_SERVICES ? sessionService : undefined;
}

/** 会话命令需要的宿主能力。 */
export interface SessionCommandHost {
  ui: TUI;
  editor: Pick<CustomEditor, 'getHistory' | 'setText' | 'showInlineMenu'>;
  deps: TuiDeps;
  session: SessionPort;
  addNotice(text: string, level?: 'dim' | 'warn' | 'error' | 'success'): void;
  /** 焦点交回输入框（/history 回填之后）。 */
  focusEditor(): void;
  /** /new 的落地：锁新会话并复位转录与跨轮次状态。 */
  startSession(next: SessionPort): void;
  /** /resume 的落地：claim 会话锁、换会话文件、回放恢复。 */
  switchToSession(id: string): void;
}

/**
 * `/history`：弹窗列出本会话发过的 prompt（最新在前，带时间），选中回填输入框
 * 可直接改了重发。数据与 ↑ 回放共用同一份编辑器历史。
 */
export async function commandHistory(host: SessionCommandHost): Promise<void> {
  const { ui, editor } = host;
  const history = editor.getHistory();
  if (history.length === 0) {
    host.addNotice('No prompt history yet — sent prompts land here', 'dim');
    return;
  }
  const items: SelectItem[] = history.map((entry) => {
    const time = new Date(entry.ts);
    const sameDay = new Date().toDateString() === time.toDateString();
    const stamp = sameDay
      ? `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
      : `${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    return {
      value: entry.text,
      label: `${stamp}  ${flattenWhitespace(entry.text).slice(0, 70)}`,
    };
  });
  const picked = await showSelectDialog(ui, {
    title: 'Prompt history',
    items,
    maxVisible: 14,
    hint: '↑↓ select · Enter reuse · Esc close',
  });
  if (picked !== undefined) {
    editor.setText(picked);
    host.focusEditor();
  }
}

/** /new 确认后的落地：建新会话文件，锁成功才切（失败仍占用当前会话）。 */
export async function commandNewSession(host: SessionCommandHost): Promise<void> {
  const confirmed = await showConfirmDialog(host.ui, {
    title: 'Start a new session?',
    message: 'The current conversation stays on disk and can be resumed later.',
    confirmLabel: 'New session',
    cancelLabel: 'Cancel',
  });
  if (!confirmed) return;
  const sessionApi = sessionsOf(host.deps);
  if (!sessionApi) {
    host.addNotice('sph-session is not loaded.', 'warn');
    return;
  }
  const next = sessionApi.factory.create(host.deps.sessionDir, host.deps.workspaceRoot);
  host.startSession(next);
}

/**
 * `/resume [id]`：带 id 前缀匹配直接切换，不带 id 打开选择器。
 *
 * 选择器接受打字和粘贴：按会话 id 前缀过滤，回车打开当前项。
 * `/resume <id>` 仍是不打开选择器的直达。`/sessions` 是别名。
 *
 * 只有主会话可选。子代理会话是主会话跑出来的内部转录（同一个目录、独立文件），
 * 切进去等于把某次 subagent 的中间过程当成一段独立对话继续，语义上不成立；
 * 按 id 精确查找时要把它们一起捞出来，才能区分「不存在」和「是子代理会话」，
 * 否则用户从工具详情里抄来的子会话 id 只会得到一句「没有匹配的会话」。
 */
export async function commandResume(host: SessionCommandHost, id: string): Promise<void> {
  const { deps, session } = host;
  const sessionApi = sessionsOf(deps);
  if (!sessionApi) {
    host.addNotice('sph-session is not loaded.', 'warn');
    return;
  }
  if (id !== '') {
    const sessions = await sessionApi.list(deps.sessionDir, { includeSubagents: true });
    const match = sessions.find((info) => info.id === id || info.id.startsWith(id));
    if (!match) {
      host.addNotice(`No session matching "${id}".`, 'warn');
      return;
    }
    if (match.parentId !== undefined) {
      host.addNotice(
        `Session ${match.id} is a subagent session of ${match.parentId} — /resume ${match.parentId} opens the main session.`,
        'warn',
      );
      return;
    }
    if (match.id === session.id) {
      host.addNotice('Already on that session.', 'dim');
      return;
    }
    host.switchToSession(match.id);
    return;
  }

  const sessions = await sessionApi.list(deps.sessionDir);
  if (sessions.length === 0) {
    host.addNotice('No sessions yet.', 'dim');
    return;
  }
  const items: SelectItem[] = sessions.map((info) => ({
    value: info.id,
    label: `${info.id}${info.id === session.id ? '  (current)' : ''}`,
    description: `${new Date(info.mtimeMs).toISOString().replace('T', ' ').slice(0, 16)} · ${info.messages} msgs${subagentCountLabel(info.subagents)} · ${info.preview}`,
  }));
  const selected = await host.editor.showInlineMenu({
    title: 'Sessions',
    items,
    maxVisible: 12,
    primaryColumnWidth: primaryColumnWidthFor(items),
    filterable: true,
  });
  if (!selected || selected.value === session.id) return;
  host.switchToSession(selected.value);
}

/** 列表里主会话的副标题后缀：让「这个会话派过几个子代理」可见。 */
function subagentCountLabel(count: number): string {
  return count === 0 ? '' : ` · ${count} subagent${count === 1 ? '' : 's'}`;
}

export async function commandExport(host: SessionCommandHost, argument: string): Promise<void> {
  const format = argument === 'json' || argument === 'html' ? argument : 'md';
  const sessionApi = sessionsOf(host.deps);
  if (!sessionApi) {
    host.addNotice('sph-session is not loaded.', 'warn');
    return;
  }
  const body = format === 'json'
    ? sessionApi.exportJson(host.session)
    : format === 'html'
      ? sessionApi.exportHtml(host.session)
      : sessionApi.exportMarkdown(host.session);
  await showMessageDialog(host.ui, {
    title: `Export (${format})`,
    text: `\`\`\`\n${body.slice(0, 12_000)}${body.length > 12_000 ? '\n…' : ''}\n\`\`\``,
  });
}
