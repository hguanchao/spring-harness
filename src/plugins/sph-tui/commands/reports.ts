/**
 * `/skills`、`/plugins` 与 `/mcps` 的上报文本。
 *
 * 只做「数据 → markdown」，不碰 TUI：拉取数据留在命令里，排版留在纯函数里。这样这几份
 * 文本不用驱动整个 TUI 就能测，而它们恰恰是最容易退化成空壳的地方——列表为空、某个
 * server 连不上、路径里带反引号，都是真实会遇到而手测很容易漏的分支。
 *
 * **正文段落一律写成一行源文本**，别手工折行：markdown 把段内的换行当硬换行保留（转录区
 * 要照搬模型自己的换行），手折过的段落会被逐行再按弹窗宽度折一次，于是出现
 * 「…can use. A / tool you / expected…」这种碎句。宽度是浮动的，折行只能交给渲染器。
 */

import type { McpServerStatus } from '@/plugins/services.js';
import type { McpSourceReport } from '@/plugins/services.js';
import type { LoadedPlugin } from '@/plugins/host.js';
import type { PluginLoadFailure } from '@/plugins/loader.js';
import type { SkillEntry, SkillRoot } from '@/plugins/sph-skills/scan.js';
import type { AppKeybindingDefinition } from '@/plugins/sph-tui/input/app-keybindings.js';
import type { CommandItem } from '@/plugins/sph-tui/commands/index.js';
import { formatKeyText } from '@/tui/input/keybindings.js';
import { compileLayers, type RuleLayers } from '@/permission/policy.js';

/**
 * 反引号包裹：内容里的反引号换成单引号。
 *
 * 技能与工具名、路径、启动命令都来自用户自己的文件/配置，里面出现反引号完全正常；
 * 不处理会把 markdown 的内联代码段提前闭合，后面的排版整段错乱。
 */
function code(text: string): string {
  return `\`${text.replaceAll('`', "'")}\``;
}

/** 单行化：描述里的换行会把一条列表项撑成好几行，破坏每条目一行的排版。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 非代码位置的正文（描述类）。
 *
 * 反引号同样要中和——描述不包在反引号里，但它**自己带反引号**时一样会开出一个未闭合的
 * 内联代码段。这一点很容易漏：路径走 code() 就安全了，描述不走，于是只有描述会破排版。
 */
function plain(text: string): string {
  return oneLine(text).replaceAll('`', "'");
}

/**
 * 次要信息（来源、根目录这类）：`{{…}}` 由 markdown 主题画成蓝色（行内码同一档）。
 */
function secondary(text: string): string {
  return `{{${oneLine(text)}}}`;
}

/**
 * 弱化信息（技能路径这类）：`%%…%%` 由 markdown 主题画成中性灰。
 *
 * 与 `secondary` 分开是因为同一条技能要两种语气：名字和描述是正文，「它落在哪个文件」只是
 * 一条你核对时才要看的注脚——跟着正文一起蓝，会让整份清单看起来每条都有两个重点。
 */
function muted(text: string): string {
  return `%%${oneLine(text)}%%`;
}

function warningsSection(warnings: readonly string[], title: string): string[] {
  if (warnings.length === 0) return [];
  return ['', `### ${title}`, ...warnings.map((warning) => `- ${plain(warning)}`)];
}

/** 把根路径里的用户主目录换成 `~`：弹窗一行装不下整条绝对路径。分隔符照原样留，不假装是 POSIX 路径。 */
function shortenRoot(path: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function renderSkillsReport(input: {
  catalog: readonly SkillEntry[];
  warnings: readonly string[];
  /** 根清单（顺序即覆盖顺序，后者覆盖前者）。带分级，组标题里要写 `User` / `Project`。 */
  roots: readonly SkillRoot[];
}): string {
  const { catalog, warnings, roots } = input;
  const lines: string[] = [];
  const total = catalog.length;
  const paths = roots.map((root) => root.path);
  const levelOf = new Map(roots.map((root) => [root.path, root.level]));

  // 根在清单里的位置就是优先级：后者覆盖前者。显示时倒过来数：**号数的是列出来的那些**，
  // `#1` = 会赢的那个。按全部六个根排号会让「只有一个来源」的机器看到 `#6`，像少了五条。
  const indexOfRoot = (root: string): number => paths.lastIndexOf(root);
  const byPriority = <T>(items: readonly T[], key: (item: T) => string): T[] =>
    [...items].sort((left, right) => indexOfRoot(key(right)) - indexOfRoot(key(left)));
  const groups = new Map<string, SkillEntry[]>();
  for (const skill of catalog) {
    const bucket = groups.get(skill.root) ?? [];
    bucket.push(skill);
    groups.set(skill.root, bucket);
  }
  const ordered = byPriority([...groups.entries()], (group) => group[0]);

  // 说明压成一行 caption（%%…%% 灰）：它回答的是「这份清单怎么被用」，读过一次就有数；
  // 整段的机制讲解只对第一次打开的人有用，不该每次都吃掉折叠前的正文行。
  lines.push(muted('Matched by name+description; SKILL.md loads on use.'), '');
  if (total === 0) {
    lines.push(
      'No skills found. A skill is a directory holding `SKILL.md` with `name` and `description` frontmatter — drop one in any root below and it is picked up on the next turn.',
      '',
    );
  }
  // 每个有货的来源都画组标题，哪怕只有一个：它回答的是「这些技能从哪来」——
  // 那正是打开这份报告要确认的事，不能因为「没有竞争」就省掉。
  for (const [index, group] of ordered.entries()) {
    const [root, skills] = group;
    if (index > 0) lines.push('');
    // 组标题里不套内联标记：h3 的横线把标题当纯文本画，`{{…}}` 会照原样露出来。
    const level = levelOf.get(root);
    lines.push(`### #${index + 1}  ${level === undefined ? '' : `${level} — `}${shortenRoot(root)} · ${skills.length}`, '');
    for (const skill of skills) lines.push(`- ${code(skill.name)} — ${plain(skill.description)}`);
  }

  const missed = roots.filter((root) => !groups.has(root.path));
  if (total === 0) {
    // 空状态这份清单和分组那份同一个方向：`1` 是会赢的那个（覆盖顺序里排最后的根）。
    lines.push('', '### Roots · the lower number wins a name clash', '');
    byPriority(roots, (root) => root.path).forEach((root, position) => {
      lines.push(`${position + 1}. ${secondary(`${root.level} — ${root.path}`)}`);
    });
  } else {
    // 优先级规则收成 caption：组标题带 # 号之后它就是「怎么读这些号」的注释，不是正文。
    if (ordered.length > 1) {
      lines.push('', muted('A skill advertised by two roots resolves to the lower #.'), muted('Later roots override earlier ones.'));
    }
    if (missed.length > 0) {
      // 空根只占一句：它们回答的是「我放了文件怎么没出现」，逐个列出来又会吃掉半屏。
      lines.push('', muted(`nothing found in ${missed.length} other root${missed.length === 1 ? '' : 's'}: ${missed.map((root) => shortenRoot(root.path)).join(' · ')}`));
    }
  }

  lines.push(...warningsSection(warnings, 'Warnings'));
  return lines.join('\n');
}

export function renderMcpReport(input: {
  servers: readonly McpServerStatus[];
  warnings: readonly string[];
  /** 候选来源文件的读取结果；回答「我明明配了怎么没生效」。 */
  sources?: readonly McpSourceReport[];
}): string {
  const { servers, warnings, sources = [] } = input;
  const reachable = servers.filter((server) => server.connected).length;
  const lines: string[] = [
    // 「状态是当下取的」这句原来挤在底边框提示里，被省略号截掉；报告正文才是它该在的位置。
    `### MCP servers (${reachable} connected / ${servers.length} discovered) — status is live as of this frame`,
    '',
  ];

  if (servers.length === 0) {
    lines.push(
      'No MCP servers found. Put one in any source below and press `r`:',
      '',
      '```toml',
      '# ~/.sph/config.toml (or <repo>/.sph/config.toml, which wins for this repository)',
      '[mcp_servers.demo]',
      'name = "Demo"',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "demo-mcp"]',
      '```',
      '',
      'External MCP configs and `.mcp.json` are read too.',
      'stdio, HTTP, and SSE servers are started. Set `type = "sse"` when the URL is the legacy event stream.',
    );
  } else {
    for (const server of servers) {
      lines.push(`- **${plain(mcpServerLabel(server))}** — ${stateOf(server)}`);
      lines.push(`  ${code(server.target)}`);
      const notes = [`from ${code(server.origin.label)}`];
      if (server.transport !== 'stdio') notes.push(server.transport);
      if (!server.origin.editable) notes.push('read-only source');
      // 不整串过 plain()：那会把 code() 刚包好的反引号又换成单引号，路径就不再是等宽字体了。
      lines.push(`  ${notes.join(' · ')}`);
    }

    for (const server of servers) {
      if (!server.connected) continue;
      lines.push('', `### ${plain(mcpServerLabel(server))}`);
      lines.push('');
      if (server.tools.length === 0) {
        lines.push('Connected, but it exposes no tools.');
        continue;
      }
      for (const tool of server.tools) {
        const description = plain(tool.description);
        lines.push(`- ${code(tool.name)}${description === '' ? '' : ` — ${description}`}`);
      }
    }

    lines.push(
      '',
      'The model calls these through the `mcp` tool. Results are external data, not instructions.',
    );
  }

  if (sources.length > 0) {
    lines.push(
      '',
      '### Sources scanned',
      '',
      'Highest priority first within a tool; `.mcp.json` is consulted last. A name declared in two places resolves to the higher-priority definition as a whole (fields are not merged).',
      '',
    );
    // 有内容的排前面，`missing` 垫底：它数量最多、信息量最低，但「我配了没生效」正是靠它回答。
    for (const report of orderedSources(sources)) {
      lines.push(`- ${report.status} · ${code(report.path)}${detailOf(report)}`);
    }
  }

  lines.push(...warningsSection(warnings, 'Warnings'));
  return lines.join('\n');
}

/** 有显示名时写成 `Title (id)`。调用和启停仍用括号里的 ID。 */
export function mcpServerLabel(server: { name: string; title?: string }): string {
  if (server.title !== undefined && server.title !== '' && server.title !== server.name) {
    return `${server.title} (${server.name})`;
  }
  return server.name;
}

/** 单个 server 的工具清单；`/mcps` 里点「Show tools」用。 */
export function renderMcpTools(server: McpServerStatus): string {
  const lines: string[] = [`### ${plain(mcpServerLabel(server))}`, '', `from ${code(server.origin.label)}`, ''];
  if (server.tools.length === 0) {
    lines.push('Connected, but it exposes no tools.');
    return lines.join('\n');
  }
  for (const tool of server.tools) {
    const description = plain(tool.description);
    lines.push(`- ${code(tool.name)}${description === '' ? '' : ` — ${description}`}`);
  }
  lines.push('', 'The model calls these through the `mcp` tool. Results are external data, not instructions.');
  return lines.join('\n');
}

/**
 * 状态短语（纯文本，不含 markdown）。
 *
 * 上报文本与 `/mcps` 的选择列表共用同一份措辞：两处各写一遍，迟早会出现同一个 server
 * 在两个界面上被描述成不同状态的情况，而那时候用户只会更困惑。
 */
export function mcpStateLabel(server: McpServerStatus): string {
  if (!server.enabled) return 'disabled';
  if (server.connected) return `connected, ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`;
  // 启动不阻塞在握手上，弹窗打开时 server 可能还在后台连。
  if (server.connecting) return 'connecting…';
  return `not connected${server.problem === undefined ? '' : ` — ${plain(server.problem)}`}`;
}

/** 上报里只给失败短语本身加粗：它是列表里唯一需要一眼扫到的信息。 */
function stateOf(server: McpServerStatus): string {
  const label = mcpStateLabel(server);
  return label.startsWith('not connected') ? label.replace('not connected', '**not connected**') : label;
}

const SOURCE_ORDER: Readonly<Record<McpSourceReport['status'], number>> = {
  found: 0,
  invalid: 1,
  skipped: 2,
  empty: 3,
  missing: 4,
};

function orderedSources(sources: readonly McpSourceReport[]): McpSourceReport[] {
  return [...sources].sort((a, b) => SOURCE_ORDER[a.status] - SOURCE_ORDER[b.status]);
}

function detailOf(report: McpSourceReport): string {
  if (report.status === 'found') return ` — ${report.count} server${report.count === 1 ? '' : 's'}`;
  if (report.detail === undefined) return '';
  return ` — ${plain(report.detail)}`;
}

/** 插件来源的展示顺序与标题：同源的插件连着排，来源只写一次。 */
const PLUGIN_ORIGINS: readonly { root: LoadedPlugin['root']; label: string }[] = [
  { root: 'bundled', label: 'Bundled with sph' },
  { root: 'user', label: 'User — ~/.sph/plugins' },
  { root: 'project', label: 'Project — <workspace>/.sph/plugins' },
];

/** 名字列表 → 行内码（蓝）串。 */
function listOf(names: readonly string[], format: (name: string) => string = (name) => name): string {
  return names.map((name) => code(format(name))).join(', ');
}

/**
 * 入口路径只留尾部三段。
 *
 * 构建产物目录动辄六七十列，整条绝对路径会把每个插件都撑成两行；来源已经由分组标题交代，
 * 尾部三段足够回答「装的是哪一个」。截过就带 `…/`，别让人以为是完整的相对路径。
 */
function entryLabel(entry: string): string {
  const parts = oneLine(entry).split(/[\\/]/).filter((part) => part !== '');
  if (parts.length <= 3) return entry;
  return `…/${parts.slice(-3).join('/')}`;
}

/** 一个插件提供了什么：只列非空的那几项；全空时明说，不留空白让人以为被截断。 */
function pluginProvides(plugin: LoadedPlugin): string {
  const parts: string[] = [];
  if (plugin.tools.length > 0) parts.push(`tools: ${listOf(plugin.tools)}`);
  if (plugin.services.length > 0) parts.push(`services: ${listOf(plugin.services)}`);
  if (plugin.commands.length > 0) parts.push(`commands: ${listOf(plugin.commands, (name) => `/${name}`)}`);
  return parts.length === 0 ? 'registers nothing' : parts.join(' · ');
}

/**
 * `/plugins` 的上报文本：装了哪些插件、各自贡献了什么、谁没装起来。
 *
 * 这份文本的存在理由是**可诊断**：工具变成插件之后，「工具表里怎么没有 todo」的答案可能
 * 是「插件被 `[plugins] disabled` 关了」、「插件加载失败」，或「插件在但没注册工具」。
 * 三种原因的处置完全不同，所以三者都要能被看见——只列一份成功清单等于让用户去猜。
 *
 * 排版按「来源分组 + 一插件一行」：来源只写一次（内置插件十几个，逐条重复 from 会把
 * 真正要看的工具/服务埋掉），一插件的摘要压成一行，文件路径退成灰色注脚——和 `/skills`
 * 同一套读法：名字与摘要进视线，路径要核对时才看。
 */
export function renderPluginsReport(input: {
  plugins: readonly LoadedPlugin[];
  failures: readonly PluginLoadFailure[];
  shadowed: readonly string[];
  /** 试图替换固定内置插件、但被拒绝的名字。内置实现仍在。 */
  pinned?: readonly string[];
}): string {
  const { plugins, failures, shadowed, pinned = [] } = input;
  const lines: string[] = [];

  if (plugins.length === 0) {
    lines.push(
      'No plugins loaded. Bundled plugins live in `src/plugins/` (compiled into `dist/`); third-party ones go in `~/.sph/plugins/` or `<workspace>/.sph/plugins/`.',
      '',
      'A plugin disabled in config.toml is deliberately absent:',
      '',
      '```toml',
      '[plugins]',
      'disabled = ["sph-mcp"]',
      '```',
    );
  } else {
    // 一句话 caption 交代最常核对的约束（改动要重启才生效）；「插件是什么」的长文
    // 对健康清单是噪音，诊断语境留给空态与失败段。
    lines.push(muted('Plugin state is fixed for this process — restart to pick up changes.'), '');
    for (const { root, label } of PLUGIN_ORIGINS) {
      const group = plugins.filter((plugin) => plugin.root === root);
      if (group.length === 0) continue;
      lines.push(`### ${label}`, '');
      for (const plugin of group) {
        lines.push(`- ${code(plugin.name)} — ${pluginProvides(plugin)}`);
        // 入口只给第三方插件留注脚：内置插件的入口就是构建产物里那个固定位置，写出来是噪音；
        // 而「同名插件到底装在用户目录还是仓库里」才是真要核对的。加载失败的那些在
        // `### Failed to load` 段里照样带入口，诊断不受影响。
        if (plugin.root !== 'bundled') {
          for (const entry of plugin.entries) lines.push(`  ${muted(entryLabel(entry))}`);
        }
        for (const warning of plugin.warnings) lines.push(`  ! !!${plain(warning)}!!`);
      }
    }
  }

  if (shadowed.length > 0) {
    lines.push(
      '',
      '### Shadowing',
      '',
      'These bundled plugins were replaced by a same-named third-party plugin. Legitimate for',
      'patching a built-in, but the bundled service and tools are gone, not merged:',
      ...shadowed.map((name) => `- ${name}`),
    );
  }

  if (pinned.length > 0) {
    lines.push(
      '',
      '### Pinned',
      '',
      'These bundled plugins stay loaded. A same-named third-party plugin was ignored:',
      ...pinned.map((name) => `- ${name}`),
    );
  }

  if (failures.length > 0) {
    lines.push('', '### Failed to load', '');
    for (const failure of failures) {
      // 失败的名字上 error 红：这一段里它是异常项本体，不该和正常清单一个脸色。
      lines.push(`- @@${failure.name}@@ — ${plain(failure.reason)}`);
      for (const entry of failure.entries) lines.push(`  - ${plain(entry)}`);
    }
  }

  return lines.join('\n');
}

/**
 * `/permissions` 的上报文本。
 *
 * 号就是求值顺序：`compileLayers` 给出的次序（deny 用户级→项目级，再 ask，最后 allow，
 * 先命中先定论）。按层分两段列是原来那种「读的人自己脑内合并」，而「我这条怎么没生效」
 * 的答案恰恰落在合并之后的位次上——所以这里编号，并被下面的诊断句直接引用。
 */
export function renderPermissionsReport(input: {
  approval: string;
  sandboxMode: string;
  sandboxAutoAllow: boolean;
  layers: RuleLayers;
  userSourceDir: string;
  projectPath: string;
  projectAllowDropped: boolean;
  approved: readonly string[];
  grantsPath: string;
}): string {
  const lines: string[] = [
    `Approval mode: ${input.approval}`,
    `Sandbox: ${input.sandboxMode}${input.sandboxAutoAllow ? ' — shell commands inside the sandbox are not asked' : ''}`,
    '',
  ];
  const compiled = compileLayers(input.layers);
  lines.push('### Rules · evaluated in this order', '');
  if (compiled.length === 0) lines.push('No rules in either layer.', '');
  compiled.forEach((entry, index) => {
    // 号 · 动作 · 规则 三列（动作是词项，走 termColumnLists 的列轨）；来源作灰注脚。
    lines.push(`${index + 1}. ${code(entry.action)} — ${plain(entry.raw)} · ${muted(entry.layerKey)}`);
  });
  if (input.projectAllowDropped) {
    const dropped = compiled
      .map((entry, index) => (entry.layerKey === 'project' && entry.action === 'allow' ? index + 1 : 0))
      .filter((number) => number > 0);
    if (dropped.length > 0) {
      lines.push(
        '',
        `${dropped.map((number) => `#${number}`).join(', ')} ignored — this workspace is not trusted (deny / ask still apply).`,
      );
    }
  }
  lines.push(
    '',
    '### Layers',
    '',
    // 路径走 `%%…%%` 而不是 plain：markdown 会把 `\U` `\.` 这类反斜杠当转义吃掉，
    // 而内联标记的内容是逐字保留的（见文件头说明）。
    `- ${code('user')} — ${muted(input.userSourceDir || '(none)')}`,
    `- ${code('project')} — ${muted(input.projectPath)}`,
    '',
    `### Approved actions · ${input.approved.length}`,
    '',
    `from ${muted(input.grantsPath)}`,
    ...(input.approved.length === 0 ? [] : input.approved.slice(0, 20).map((key) => `- ${plain(key)}`)),
    ...(input.approved.length > 20 ? [`  … ${input.approved.length - 20} more`] : []),
  );
  return lines.join('\n');
}

/**
 * `/help` 的上报文本：命令表 + 键位 + 队列与编辑器说明。
 *
 * 命令与键位都由调用方从注册表取来注入，所以新加一条命令、一个键位，这份帮助自动跟上——
 * 手抄一份清单必然漂移，这正是当初把面板改成从注册表取数的原因。
 *
 * 键位必须带生效上下文：Esc 在「有轮次在跑」和「空闲」下做的事不同，只列键名等于把人往
 * 误操作上引（见 app-keybindings 的 when）。
 */
export function renderHelpReport(input: {
  commands: readonly CommandItem[];
  /** 别名 → 正名。别名不进正列，但必须能看见，否则靠旧名字找命令的人会以为它没了。 */
  aliases: Readonly<Record<string, string>>;
  keybindings: readonly AppKeybindingDefinition[];
}): string {
  const { commands, aliases, keybindings } = input;
  // 说明压成 caption：它交代的是用法前提（敲 / 补全、别名跟在正名旁边），不是每次都要重读的正文。
  const lines: string[] = [
    muted('Type / to autocomplete. A command that also answers to an older name shows that name beside it.'),
    '',
    '### Commands',
    '',
  ];

  const groups = new Map<string, CommandItem[]>();
  for (const command of commands) {
    const bucket = groups.get(command.group) ?? [];
    bucket.push(command);
    groups.set(command.group, bucket);
  }
  for (const [group, groupCommands] of groups) {
    // 分组名与命令段同级：markdown 只给 h3 及以上画横线，再往下没有可用的视觉层次。
    lines.push(`### ${group}`, '');
    for (const command of groupCommands) {
      const alias = Object.entries(aliases).find(([, canonical]) => canonical === command.id)?.[0];
      const suffix = alias === undefined ? '' : `  ${muted(`also /${alias}`)}`;
      lines.push(`- ${code(command.label)} — ${plain(command.hint)}${suffix}`);
    }
    lines.push('');
  }

  const keyGroups = new Map<string, AppKeybindingDefinition[]>();
  for (const definition of keybindings) {
    const bucket = keyGroups.get(definition.when) ?? [];
    bucket.push(definition);
    keyGroups.set(definition.when, bucket);
  }
  for (const [when, definitions] of keyGroups) {
    lines.push(`### Keys · ${when === 'always' ? 'available anytime' : when}`, '');
    for (const definition of definitions) {
      lines.push(`- ${code(formatKeyText(definition.keys.join('/')))} — ${plain(definition.description)}`);
    }
    lines.push('');
  }

  // 鼠标与编辑器这两段没有注册表可取（它们描述的是控件行为，不是配置项），只能写死在这里。
  lines.push(
    '### Queue (mouse)',
    '',
    '- Hover a queued row for its [↑] [↓] [Send now] [edit] [cancel] buttons',
    '- Click a row to select it; [edit] takes it back to the input (queued order preserved)',
    '',
    '### Editor',
    '',
    '- `/` — slash-command autocomplete in the editor',
    '- Enter while a turn runs — queue the message (delivered after the turn ends)',
    '- Alt+Enter — queue a follow-up that starts after this turn',
  );
  return lines.join('\n');
}
