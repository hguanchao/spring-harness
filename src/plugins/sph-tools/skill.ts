import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asString, clip, type ToolContext, type ToolResult, type ToolSpec } from '../../tools/types.js';

/** 附属清单的容量上限：技能目录是用户可控输入，防止异常多的条目灌爆工具结果。 */
const MAX_ATTACHMENTS = 20;

/** 列出技能目录里 SKILL.md 之外的附属文件，供模型按需用 read 工具取用。 */
function listAttachments(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name !== 'SKILL.md');
  } catch {
    return '';
  }
  const lines: string[] = [];
  for (const name of names.slice(0, MAX_ATTACHMENTS)) {
    try {
      const stats = statSync(join(dir, name));
      if (!stats.isFile()) continue;
      lines.push(`- ${name} (${Math.ceil(stats.size / 1024)} KB)`);
    } catch {
      // 条目在扫描间隙被删掉是正常竞态，跳过即可。
    }
  }
  return lines.join('\n');
}

export const skillTool: ToolSpec = {
  name: 'skill',
  description: 'Load a SKILL.md by catalog name when a listed skill matches the task. Your instructions list only its name and description; this returns the full file, so call it before following a skill you have not read. The result may end with an "Attached files" list: those live next to the SKILL.md and are NOT included — read the ones you need with the read tool when the skill body references them.',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const name = asString(args, 'name');
    const entry = ctx.skills.find((skill) => skill.name === name);
    if (!entry) return { ok: false, content: `unknown skill: ${name}` };
    if (!existsSync(entry.path)) return { ok: false, content: `skill file missing: ${entry.path}` };
    // 附属清单附在正文之后：第三级披露——SKILL.md 只写索引，用到再读，prompt 目录成本不变。
    const attachments = listAttachments(dirname(entry.path));
    // 附录预算从正文里扣，而不是整体 clip：否则正文撑满 20k 时附录恰好被截掉。
    const appendix = attachments === ''
      ? ''
      : `\n\nAttached files (read on demand with the read tool):\n${attachments}`;
    const body = clip(readFileSync(entry.path, 'utf8'), 20_000 - appendix.length);
    return { ok: true, content: body + appendix };
  },
};
