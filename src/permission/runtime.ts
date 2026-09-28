/**
 * 权限运行时：把「规则分层 + 授权落盘 + 沙箱档位」这三件审批要用的事收在一个对象里。
 *
 * 为什么不让各处自己拼：审批器（交互式与 headless）需要它们，`/permissions` 要展示它们，
 * 规则写回还要有它们。散成六个依赖时，每加一处调用点就要在四个文件里各补一遍，而漏补
 * 的后果是「某个入口没吃到规则」——安全相关的东西不该有这种静默缺口。
 *
 * 项目级规则在启动时读一次（见 config/project.ts）。运行中改项目配置需要重启：规则是
 * 安全边界的输入，热重载它意味着一次编辑能在会话中途改变授权面。
 */

import type { PermissionRules, RuleEnv, RuleLayers } from './policy.js';
import { EMPTY_RULES } from './policy.js';
import { createGrantStore, type GrantStore } from './store.js';
import type { SandboxMode } from '../sandbox/types.js';
import { appendProjectAllowRule, projectConfigPath, type ProjectPermissions } from '../config/project.js';

export interface PermissionRuntime {
  /** 生效的规则分层，按需构造（项目级可能缺席）。 */
  layers(): RuleLayers;
  /** 路径规则的锚定环境。 */
  readonly ruleEnv: RuleEnv;
  /** 沙箱档位与免问开关；都是启动参数，运行中不变。 */
  sandbox(): { mode: SandboxMode; autoAllow: boolean };
  /** 本项目的授权读写口。 */
  grants(): GrantStore;
  /** 项目级配置的落点（文件可能还不存在）。 */
  projectPath(): string;
  /** 项目级 allow 因为工作区未信任而被丢弃了。 */
  projectAllowDropped(): boolean;
  /** 能不能把规则写进项目级配置：未信任的仓库不写。 */
  canWriteProjectRule(): boolean;
  /** 把一条规则追加进项目级 `[permissions].allow`。 */
  addProjectRule(rule: string): { path: string; added: boolean };
}

export function createPermissionRuntime(input: {
  workspaceRoot: string;
  userRules: PermissionRules;
  /** 用户级规则的来源目录（`~/.sph`），路径规则的 `/` 锚定到它。 */
  userRulesDir: string;
  home: string;
  sandboxMode: SandboxMode;
  sandboxAutoAllow: boolean;
  trusted: boolean;
  project?: ProjectPermissions;
}): PermissionRuntime {
  const ruleEnv: RuleEnv = { workspaceRoot: input.workspaceRoot, home: input.home };
  let grantStore: GrantStore | undefined;
  // 项目级规则要留一份**可变**的内存副本：批准弹窗里选了「提升为规则」时，规则必须立刻
  // 生效——只写盘不改内存，第二次调用还会再弹一次，用户会觉得刚才那一下白点了。
  // 文件还不存在时也建这份副本：第一次追加不能等重启才进 layers()。未信任时不建，
  // 那种 allow 本来就会被信任门丢掉。
  const project = input.trusted
    ? {
        path: input.project?.path ?? projectConfigPath(input.workspaceRoot),
        sourceDir: input.project?.sourceDir ?? input.workspaceRoot,
        allowDropped: input.project?.allowDropped === true,
        rules: {
          allow: [...(input.project?.rules.allow ?? EMPTY_RULES.allow)],
          ask: [...(input.project?.rules.ask ?? EMPTY_RULES.ask)],
          deny: [...(input.project?.rules.deny ?? EMPTY_RULES.deny)],
        },
      }
    : input.project === undefined
      ? undefined
      : {
          path: input.project.path,
          sourceDir: input.project.sourceDir,
          allowDropped: input.project.allowDropped,
          rules: {
            allow: [...input.project.rules.allow],
            ask: [...input.project.rules.ask],
            deny: [...input.project.rules.deny],
          },
        };
  return {
    ruleEnv,
    layers: () => ({
      user: { rules: input.userRules, sourceDir: input.userRulesDir },
      ...(project === undefined ? {} : { project: { rules: project.rules, sourceDir: project.sourceDir } }),
    }),
    sandbox: () => ({ mode: input.sandboxMode, autoAllow: input.sandboxAutoAllow }),
    grants: () => (grantStore ??= createGrantStore(input.workspaceRoot)),
    projectPath: () => input.project?.path ?? projectConfigPath(input.workspaceRoot),
    projectAllowDropped: () => project?.allowDropped === true,
    canWriteProjectRule: () => input.trusted,
    addProjectRule: (rule) => {
      const result = appendProjectAllowRule(input.workspaceRoot, rule);
      if (project !== undefined && !project.rules.allow.includes(rule)) project.rules.allow.push(rule);
      return result;
    },
  };
}
