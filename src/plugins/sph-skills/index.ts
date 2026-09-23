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

/** 插件入口。宿主按 `src/plugins/sph-skills/` 装载。 */
export default function setup(api: PluginApi): void {
  api.provide(SKILLS_SERVICE, service);
}
