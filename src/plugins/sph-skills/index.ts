/**
 * sph-skills：发现工作区与用户目录里的 SKILL.md。
 */
import type { PluginApi } from '../types.js';
import { SKILLS_SERVICE, type SkillService } from '../services.js';
import { scanSkills, skillRoots } from './scan.js';

const service: SkillService = {
  scan: (workspaceRoot) => scanSkills(workspaceRoot),
  roots: (workspaceRoot) => skillRoots(workspaceRoot),
};

/**
 * 插件入口。宿主按 `src/plugins/sph-skills/` 装载。
 *
 * 导出成对象形态是为了挂 `description`：函数形态的默认导出没有地方写自述，
 * 而那句自述正是 `/plugins` 明细里的第一行。
 */
function setup(api: PluginApi): void {
  api.provide(SKILLS_SERVICE, service);
}

export default {
  description: 'Finds SKILL.md files in the user and project skill roots.',
  setup,
};
