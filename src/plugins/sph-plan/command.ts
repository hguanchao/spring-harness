/**
 * `/plan` 属于这个插件。界面只负责把它放进菜单并交出一段上下文。
 */
import { SESSION_SERVICE, type SessionService } from '../services.js';
import type { PluginApi, PluginCommandContext } from '../types.js';

export function registerPlanCommand(api: PluginApi): void {
  api.registerCommand({
    name: 'plan',
    description: 'Enter plan mode, or /plan off to leave',
    run: (ctx) => runPlanCommand(ctx),
  });
}

async function runPlanCommand(ctx: PluginCommandContext): Promise<void> {
  const plan = ctx.planMode;
  if (!plan) {
    ctx.notify('Plan mode is not available in this view.', 'warn');
    return;
  }
  const write = (active: boolean): void => {
    if (plan.active === active) {
      ctx.notify(active ? 'Already in plan mode. /plan off to leave.' : 'Plan mode is already off.', 'dim');
      return;
    }
    plan.active = active;
    const events = ctx.services.get<SessionService>(SESSION_SERVICE)?.events;
    if (events) ctx.session.appendEvent('plan_mode', events.planMode(active));
    ctx.notify(
      active
        ? 'Plan mode on. Explore and design; writes are blocked until the plan is approved. /plan off to leave.'
        : 'Plan mode off.',
      'success',
    );
  };
  if (ctx.argument === 'off') {
    write(false);
    return;
  }
  if (!plan.active) write(true);
  else if (ctx.argument === '') ctx.notify('Already in plan mode. /plan off to leave.', 'dim');
  if (ctx.argument === '') return;
  if (ctx.busy) {
    ctx.notify('A turn is already running — the next step will use plan mode. Press Esc to interrupt.', 'warn');
    return;
  }
  await ctx.runPrompt(ctx.argument);
}
