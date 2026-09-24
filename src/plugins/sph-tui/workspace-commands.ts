/**
 * `/prompts`、`/diff`、`/fork`。
 *
 * 模板只展开进输入框，不进系统提示。diff 只读 git，不提交。
 * fork 复制当前消息到新会话，原会话只追加一条 session_fork。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sphHome } from '../../home.js';
import { foldSessionState, sessionEventData } from '../../session/fold.js';
import { appendableMessage } from '../sph-loop/compact.js';
import { EMPTY_PLUGIN_SERVICES } from '../types.js';
import { SESSION_SERVICE, type SessionService, type SkillEntry } from '../services.js';
import { sessionService } from '../sph-session/index.js';
import { showMessageDialog, showSelectDialog } from './dialogs.js';
import type { SessionCommandHost } from './session-commands.js';

function sessionsOf(host: SessionCommandHost): SessionService | undefined {
  const found = host.deps.pluginServices.get<SessionService>(SESSION_SERVICE);
  if (found) return found;
  return host.deps.pluginServices === EMPTY_PLUGIN_SERVICES ? sessionService : undefined;
}

function promptDirs(workspaceRoot: string): string[] {
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return [
    join(userHome, '.sph', 'prompts'),
    join(sphHome(), 'prompts'),
    join(workspaceRoot, '.sph', 'prompts'),
  ];
}

function readPrompts(workspaceRoot: string): Array<{ name: string; text: string }> {
  const byName = new Map<string, string>();
  for (const dir of promptDirs(workspaceRoot)) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of names) {
      if (!file.endsWith('.md')) continue;
      try {
        byName.set(file.slice(0, -3), readFileSync(join(dir, file), 'utf8').trim());
      } catch {
        // 一个读不了的模板不影响其余。
      }
    }
  }
  return [...byName.entries()].map(([name, text]) => ({ name, text }));
}

/** 选一个模板，正文放进输入框。 */
export async function commandPrompts(host: SessionCommandHost): Promise<void> {
  const prompts = readPrompts(host.deps.workspaceRoot);
  if (prompts.length === 0) {
    host.addNotice('No prompt templates. Put a .md file in ~/.sph/prompts or .sph/prompts.', 'dim');
    return;
  }
  const picked = await showSelectDialog(host.ui, {
    title: 'Prompt templates',
    items: prompts.map((prompt) => ({ value: prompt.name, label: prompt.name })),
    maxVisible: 12,
  });
  if (picked === undefined) return;
  const text = prompts.find((prompt) => prompt.name === picked)?.text ?? '';
  host.editor.setText(text);
  host.focusEditor();
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
showMessageDialog(host.ui, { title: 'git diff', text: text.length > 12_000 ? `${text.slice(0, 12_000)}\n…` : text });
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
