/**
 * 顶部欢迎头：左边产品名和版本，右边工作区/会话/模型/运行参数，底下一行键位。
 */

import { type Component, truncateToWidth, visibleWidth } from '../../../tui/index.js';
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

/** 左右两栏之间的空列。窄到放不下时改成上下堆叠。 */
const COLUMN_GAP = 4;

export class HeaderComponent implements Component {
  constructor(private readonly data: ReadonlyHeaderDataProvider) {}

  invalidate(): void {
    // 每帧取数，无缓存。
  }

  render(width: number): string[] {
    const data = this.data.get();
    const brand = [
      theme.bold(theme.fg('primary', 'Spring Harness')),
      theme.fg('muted', `sph v${data.version}`),
    ];
    const brandWidth = Math.max(...brand.map((line) => visibleWidth(line)));
    const meta = metaLines(data);
    const lines: string[] = [''];
    const sideBySide = width >= 2 + brandWidth + COLUMN_GAP + 24;
    if (sideBySide) {
      const rowCount = Math.max(brand.length, meta.length);
      // 产品名两行，相对右边四行垂直居中。
      const brandOffset = Math.max(0, Math.floor((meta.length - brand.length) / 2));
      for (let i = 0; i < rowCount; i++) {
        const left = i >= brandOffset && i < brandOffset + brand.length ? brand[i - brandOffset]! : '';
        const pad = ' '.repeat(Math.max(0, brandWidth - visibleWidth(left)));
        lines.push(truncateToWidth(`${' '.repeat(2)}${left}${pad}${' '.repeat(COLUMN_GAP)}${meta[i] ?? ''}`, width, ''));
      }
    } else {
      for (const line of brand) lines.push(truncateToWidth(`  ${line}`, width, ''));
      lines.push('');
      for (const line of meta) lines.push(truncateToWidth(`  ${line}`, width, ''));
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

function metaLines(data: HeaderData): string[] {
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
  return rows.map(([label, value]) => `${theme.fg('dim', label.padEnd(labelWidth))}  ${theme.fg('text', value)}`);
}
