import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sphHome } from '../../home.js';
import type { SkillEntry, SkillScan } from '../services.js';

export type { SkillEntry, SkillScan };

function parseFrontmatter(text: string): { name?: string; description?: string; userInvocable?: boolean } | undefined {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return undefined;
  const block = text.slice(3, end).replace(/^\r?\n/, '');
  const out: { name?: string; description?: string; userInvocable?: boolean } = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^(name|description|user-invocable)\s*:\s*(.+)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (match[1] === 'name') out.name = value;
    else if (match[1] === 'description') out.description = value;
    else out.userInvocable = value === 'true';
  }
  return out;
}

function scanRoot(root: string, warnings: string[], byName: Map<string, SkillEntry>): void {
  if (!existsSync(root)) return;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const skillPath = join(root, name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    let text: string;
    try {
      text = readFileSync(skillPath, 'utf8');
    } catch {
      warnings.push(`unreadable skill: ${skillPath}`);
      continue;
    }
    const meta = parseFrontmatter(text);
    if (!meta?.name || !meta.description) {
      warnings.push(`skipped skill without name/description frontmatter: ${skillPath}`);
      continue;
    }
    byName.set(meta.name, {
      name: meta.name,
      description: meta.description,
      path: skillPath,
      ...(meta.userInvocable ? { userInvocable: true } : {}),
    });
  }
}

/**
 * 技能根目录，按扫描顺序排列：**后者覆盖前者**（同名技能以靠后的为准）。
 *
 * 单独导出是给 `/skills` 用的：它要把「技能该放哪」显示给用户，不能让展示与实现
 * 各写一份目录清单——那种两份清单迟早会对不上，而用户会照着错的那份放文件。
 */
export function skillRoots(
  workspaceRoot: string,
  home = sphHome(),
  userHome = process.env.USERPROFILE ?? process.env.HOME ?? '',
): string[] {
  return [
    join(userHome, '.agents', 'skills'),
    join(userHome, '.claude', 'skills'),
    join(home, 'skills'),
    join(workspaceRoot, '.agents', 'skills'),
    join(workspaceRoot, '.claude', 'skills'),
    join(workspaceRoot, '.sph', 'skills'),
  ];
}

/** 六个根后者覆盖前者；只认 skills/<name>/SKILL.md。 */
export function scanSkills(
  workspaceRoot: string,
  home = sphHome(),
  userHome = process.env.USERPROFILE ?? process.env.HOME ?? '',
): SkillScan {
  const warnings: string[] = [];
  const byName = new Map<string, SkillEntry>();
  for (const root of skillRoots(workspaceRoot, home, userHome)) scanRoot(root, warnings, byName);
  return { catalog: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}
