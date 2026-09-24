/**
 * 顶部欢迎头：产品标识 + 工作区/会话/模型等关键上下文 + 键位提示。
 */

import { type Component, truncateToWidth } from '../../../tui/index.js';
import { theme } from '../theme/theme.js';
import { keyText } from './interaction.js';

export interface HeaderData {
  version: string;
  workspaceRoot: string;
  gitBranch?: string;
  sessionId: string;
  /** 供应商名。和模型、effort 拼在同一行。 */
  provider: string;
  model: string;
  effort?: string;
  approvalMode: string;
  sandboxMode: string;
  mcpServerCount: number;
  skillCount: number;
}

export interface ReadonlyHeaderDataProvider {
  get(): HeaderData;
}

const LOGO = [
  '  ▄▄▄▄  ▄▄▄▄  ▄▄  ▄▄',
  '  ██▄▄  ██▄█▄ ██▄▄██',
  '  ▀▀▀▀  ▀▀ ▀▀ ▀▀  ▀▀',
];

export class HeaderComponent implements Component {
  constructor(private readonly data: ReadonlyHeaderDataProvider) {}

  invalidate(): void {
    // 每帧取数，无缓存。
  }

  render(width: number): string[] {
    const data = this.data.get();
    const lines: string[] = [''];

    const logoWidth = Math.max(...LOGO.map((line) => line.length));
    const titleLines = [
      theme.bold(theme.fg('primary', 'Spring Harness')) + theme.fg('muted', `  sph v${data.version}`),
      theme.fg('muted', 'personal agent runtime'),
    ];
    const compact = width < logoWidth + 40;
    if (compact) {
      lines.push(truncateToWidth(`  ${titleLines[0]}`, width, ''));
      lines.push(truncateToWidth(`  ${titleLines[1]}`, width, ''));
    } else {
      lines.push(truncateToWidth(`  ${theme.fg('primary', LOGO[0])}  ${titleLines[0]}`, width, ''));
      lines.push(truncateToWidth(`  ${theme.fg('primary', LOGO[1])}  ${titleLines[1]}`, width, ''));
      lines.push(truncateToWidth(`  ${theme.fg('primary', LOGO[2])}`, width, ''));
    }

    lines.push('');

    const workspace = data.gitBranch ? `${data.workspaceRoot} (${data.gitBranch})` : data.workspaceRoot;
    const model = [data.provider, data.model, data.effort].filter((part) => part !== undefined && part !== '').join(' · ');
    const environment = [`approval ${data.approvalMode}`, `sandbox ${data.sandboxMode}`];
    if (data.mcpServerCount > 0) environment.push(`mcp ${data.mcpServerCount}`);
    environment.push(`skill ${data.skillCount}`);

    const rows: Array<[string, string]> = [
      ['workspace', workspace],
      ['session', data.sessionId],
      ['model', model],
      ['runtime', environment.join(' · ')],
    ];
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
      lines.push(
        truncateToWidth(`  ${theme.fg('dim', label.padEnd(labelWidth))}  ${theme.fg('text', value)}`, width, ''),
      );
    }

    lines.push('');
    const hints = [
      theme.fg('dim', '/') + theme.fg('muted', ' commands'),
      `${keyText('app.interrupt')}${theme.fg('muted', ' interrupt')}`,
      `${keyText('app.approval.cycle')}${theme.fg('muted', ' approval')}`,
      `${keyText('app.exit')}${theme.fg('muted', ' exit')}`,
      `${keyText('app.tools.expand')}${theme.fg('muted', ' tools')}`,
    ];
    lines.push(truncateToWidth(`  ${hints.join(theme.fg('dim', ' · '))}`, width, ''));
    lines.push('');
    return lines;
  }
}
