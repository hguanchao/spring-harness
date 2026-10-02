/**
 * sph-schedule：进程内后台任务。子代理的后台运行与完成通知都走这里。
 */
import type { PluginApi } from '../types.js';
import { jobNotificationText } from '../../runtime/scheduler.js';
import { SCHEDULER_SERVICE, type SchedulerService } from '../services.js';
import { JobBoard } from './jobs.js';

const service: SchedulerService = {
  create: () => new JobBoard(),
  notificationText: jobNotificationText,
};

/**
 * 插件入口。宿主按 `src/plugins/sph-schedule/` 装载。
 *
 * 导出成对象形态是为了挂 `description`：函数形态的默认导出没有地方写自述，
 * 而那句自述正是 `/plugins` 明细里的第一行。
 */
function setup(api: PluginApi): void {
  api.provide(SCHEDULER_SERVICE, service);
}

export default {
  description: 'In-process background jobs, and the notice when one finishes.',
  setup,
};
