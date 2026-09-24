/**
 * `/agent` 切换根会话的能力集。
 *
 * 名字写入会话事件，下一轮 runTurn 按那份定义收工具和角色段。
 * 一轮正在跑时不改：这次请求的工具表已经发出去了，中途换会让前缀对不上。
 */
import { SESSION_SERVICE, type SessionService } from '../services.js';
import type { PluginApi, PluginCommandContext } from '../types.js';
import { discoverAgents, findAgent } from './agents.js';

export function registerAgentCommand(api: PluginApi): void {
  api.registerCommand({
    name: 'agent',
    description: 'Choose the session agent: /agent, /agent <name>, /agent default',
    run: (ctx) => runAgentCommand(api, ctx),
  });
}

function runAgentCommand(api: PluginApi, ctx: PluginCommandContext): void {
  const agents = discoverAgents(ctx.workspaceRoot, api.host.isWorkspaceTrusted(ctx.workspaceRoot));
  const argument = ctx.argument.trim();
  if (argument === '') {
    const current = currentAgentName(ctx);
    const lines = agents.map((agent) => {
      const mark = agent.name === current ? '*' : ' ';
      return `${mark} ${agent.name} — ${agent.description}`;
    });
    ctx.notify([`Agent: ${current || 'default (every tool)'}`, ...lines, 'Use /agent <name>, or /agent default to clear.'].join('\n'), 'dim');
    return;
  }
  if (ctx.busy) {
    ctx.notify('A turn is running. Switch the agent after it finishes.', 'warn');
    return;
  }
  const name = argument === 'default' ? '' : argument;
  if (name !== '' && !findAgent(agents, name)) {
    ctx.notify(`Unknown agent "${name}". /agent lists the ones available.`, 'warn');
    return;
  }
  const events = ctx.services.get<SessionService>(SESSION_SERVICE)?.events;
  if (events) ctx.session.appendEvent('agent', events.agent(name));
  ctx.notify(name === '' ? 'Agent cleared. This session uses every tool.' : `Agent is now ${name}. The next turn uses its tools and prompt.`, 'success');
}

function currentAgentName(ctx: PluginCommandContext): string {
  const records = ctx.session.readAll();
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record || record.type !== 'event' || record.kind !== 'agent') continue;
    return typeof record.data.name === 'string' ? record.data.name : '';
  }
  return '';
}
