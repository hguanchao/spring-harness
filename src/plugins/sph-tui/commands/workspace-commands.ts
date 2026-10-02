/**
 * `/diff`、`/fork`。
 *
 * diff 只读 git，不提交。fork 复制当前消息到新会话，原会话只追加一条 session_fork。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { foldSessionState, sessionEventData } from '@/session/fold.js';
import { appendableMessage } from '@/plugins/sph-loop/compact.js';
import { EMPTY_PLUGIN_SERVICES } from '@/plugins/types.js';
import { SESSION_SERVICE, type SessionService, type SkillEntry } from '@/plugins/services.js';
import { sessionService } from '@/plugins/sph-session/index.js';
import { commandPanelOptions, showMessageDialog } from '@/plugins/sph-tui/dialogs.js';
import type { SessionCommandHost } from '@/plugins/sph-tui/commands/session-commands.js';

function sessionsOf(host: SessionCommandHost): SessionService | undefined {
  const found = host.deps.pluginServices.get<SessionService>(SESSION_SERVICE);
  if (found) return found;
  return host.deps.pluginServices === EMPTY_PLUGIN_SERVICES ? sessionService : undefined;
}

/** 只读 git diff。不是 git 仓库或没有改动时说明原因。 */
export async function commandDiff(host: SessionCommandHost): Promise<void> {
  const git = join(host.deps.workspaceRoot, '.git');
  if (!existsSync(git)) {
    host.addNotice('Not a git repository.', 'dim');
    return;
  }
  const text = await new Promise<string>((resolve) => {
    const child = spawn('git', ['diff', '--', '.'], { cwd: host.deps.workspaceRoot, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(stdout.trim() || stderr.trim()));
  });
  if (text === '') {
    host.addNotice('No unstaged diff.', 'dim');
    return;
  }
showMessageDialog(host.ui, {
  title: 'git diff',
  // 包成 diff 围栏：一是按 git 的行首前缀上色，二是别让 `- ` 行被 markdown 当成列表项。
  text: `\`\`\`diff\n${text.length > 12_000 ? `${text.slice(0, 12_000)}\n…` : text}\n\`\`\``,
  ...commandPanelOptions(host.ui),
});
}

/**
 * 把当前会话的消息复制进一个新会话，并切过去。
 * 原会话只追加 session_fork，消息一个字不改。
 */
export function commandFork(host: SessionCommandHost): void {
  const sessionApi = sessionsOf(host);
  if (!sessionApi) {
    host.addNotice('sph-session is not loaded.', 'warn');
    return;
  }
  const source = host.session.readMessages();
  const next = sessionApi.factory.create(host.deps.sessionDir, host.deps.workspaceRoot, true);
  for (const row of source) next.appendMessage(appendableMessage(row));
  const folded = foldSessionState(host.session.readAll());
  if (folded.agent !== undefined) next.appendEvent('agent', sessionEventData.agent(folded.agent));
  if (folded.goal) next.appendEvent('goal', sessionEventData.goal(folded.goal));
  if (folded.planMode) next.appendEvent('plan_mode', sessionEventData.planMode(true));
  host.session.appendEvent('session_fork', { to: next.id, covered: source.length });
  host.switchToSession(next.id);
  host.addNotice(`Forked to ${next.id}. The previous session is unchanged.`, 'success');
}

/** user-invocable 技能：把说明送进这一轮，不写进系统提示。 */
export function invocableSkillPrompt(entry: SkillEntry): string {
  return `Use the skill "${entry.name}": ${entry.description}\nLoad it with the skill tool before following it.`;
}
