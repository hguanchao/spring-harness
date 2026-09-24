/**
 * 子代理定义：一份 markdown，frontmatter 声明能力，正文是它的系统提示词。
 *
 * 代理定义文件只保留真正执行的字段：
 * name、description、tools、writes。advertise / model / chain / workflow 不在这里——
 * sph 没有那一套运行时，加字段只会让定义看起来能做它做不到的事。
 *
 * 查找顺序：内置（explore、research、writer、general）→ `~/.sph/agents/*.md` → `<workspace>/.sph/agents/*.md`。
 * 同名时近者胜，项目级整份换掉用户级。工作区未受信任时不读项目级：
 * 那是别人仓库里的提示词，和项目级插件同一道门。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sphHome } from '../../home.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { explorePrompt, generalPrompt, researchPrompt, writerPrompt } from './prompt.js';

export interface AgentDefinition {
  name: string;
  description: string;
  /**
   * 这个代理可用的工具名。`*` 表示宿主按当前工具表展开。
   * 点名的名字原样交给宿主，宿主丢掉工具表里没有的。
   * 子会话还会再去掉委托工具；根会话用 `/agent` 选中时按这份名单原样生效。
   */
  tools: string[];
  /**
   * 这个子代理会不会改文件或跑命令。plan mode 据此决定能不能派发它。
   * 省略按会写处理：一份没说清楚的定义不能在只读阶段被放行。
   */
  writes: boolean;
  /** 追加在主系统提示词之后的角色约束。 */
  systemPrompt: string;
}

/** 根会话没选代理时的名字。全工具，不追加角色段。 */
export const DEFAULT_AGENT = '';

/**
 * 把一份定义收成这次会话真正可用的工具名。
 *
 * `*` 展开成工具表里全部非 rootOnly 的名字。点名的名字丢掉工具表里没有的。
 * 根会话与子会话共用这一步：定义写了什么，schema 和提示词里就只剩什么。
 */
export function resolveAgentTools(agent: AgentDefinition, registry: ToolRegistry): Set<string> {
  if (agent.tools.includes('*')) return registry.generalNames();
  return new Set(agent.tools.filter((name) => registry.find(name)));
}

/** 内置四份。自定义文件用同名覆盖它们。 */
export function builtinAgents(): AgentDefinition[] {
  return [
    {
      name: 'explore',
      description: 'Read-only codebase exploration. Use it to find where something lives or how it works.',
      tools: ['read', 'grep', 'glob', 'ls', 'skill', 'ask_user', 'web_search', 'web_fetch'],
      writes: false,
      systemPrompt: explorePrompt(),
    },
    {
      name: 'research',
      description: 'Read-only research. Use it for a question, comparison, or summary that needs sources and does not change files.',
      tools: ['read', 'grep', 'glob', 'ls', 'skill', 'ask_user', 'web_search', 'web_fetch'],
      writes: false,
      systemPrompt: researchPrompt(),
    },
    {
      name: 'writer',
      description: 'Draft or revise a document. It can edit that document and does not change code, configuration, or tests.',
      tools: ['read', 'write', 'edit', 'grep', 'glob', 'ls', 'skill', 'ask_user', 'web_search', 'web_fetch'],
      writes: true,
      systemPrompt: writerPrompt(),
    },
    {
      name: 'general',
      description: 'General-purpose work that can read, edit, and run commands.',
      tools: ['*'],
      writes: true,
      systemPrompt: generalPrompt(),
    },
  ];
}

/**
 * 解析一份 agent 文件。缺 name、缺正文、tools 不是列表，都返回 undefined——
 * 坏定义跳过，不让一个文件挡住其余定义。
 */
export function parseAgentFile(text: string): AgentDefinition | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const body = match[2]?.trim() ?? '';
  if (body === '') return undefined;
  const fields = parseFrontmatter(match[1] ?? '');
  const name = scalar(fields, 'name');
  if (name === '') return undefined;
  const tools = list(fields, 'tools');
  if (!tools || tools.length === 0) return undefined;
  const writesRaw = scalar(fields, 'writes');
  return {
    name,
    description: scalar(fields, 'description'),
    tools,
    writes: writesRaw === 'false' ? false : true,
    systemPrompt: body,
  };
}

/** 近者胜：后出现的同名定义整份替换先出现的。 */
export function discoverAgents(
  workspaceRoot: string,
  trusted: boolean,
  /** 用户级定义目录；省略取 `~/.sph/agents`。测试传入空目录，避免读到机器上的真实文件。 */
  userAgentsDir = join(sphHome(), 'agents'),
): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of builtinAgents()) byName.set(agent.name, agent);
  for (const agent of readAgentDir(userAgentsDir)) byName.set(agent.name, agent);
  if (trusted) {
    for (const agent of readAgentDir(join(workspaceRoot, '.sph', 'agents'))) byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

export function findAgent(agents: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
  return agents.find((agent) => agent.name === name);
}

function readAgentDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const agents: AgentDefinition[] = [];
  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseAgentFile(text);
    if (parsed) agents.push(parsed);
  }
  return agents;
}

/** 只认 sph 用到的那种子集：`key: value` 与 `key: a, b`。不引入 YAML 解析器。 */
function parseFrontmatter(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match || match[1] === undefined) continue;
    fields.set(match[1], (match[2] ?? '').trim());
  }
  return fields;
}

function scalar(fields: Map<string, string>, key: string): string {
  return fields.get(key)?.trim() ?? '';
}

function list(fields: Map<string, string>, key: string): string[] | undefined {
  const raw = fields.get(key);
  if (raw === undefined || raw === '') return undefined;
  const items = raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  return items.length === 0 ? undefined : items;
}
