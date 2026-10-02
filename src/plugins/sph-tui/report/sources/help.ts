/**
 * `/help` 拆出来的两个 tab：Commands（命令清单）与 Keys（键位 + 鼠标/编辑器说明）。
 *
 * 命令与键位都由调用方从注册表取来注入，所以新加一条命令、一个键位，帮助自动跟上——
 * 手抄一份清单必然漂移，这正是当初把面板改成从注册表取数的原因。
 *
 * 键位必须带生效上下文：Esc 在「有轮次在跑」和「空闲」下做的事不同，只列键名等于把人往
 * 误操作上引（见 app-keybindings 的 when）。队列与编辑器两段没有注册表可取（它们描述的
 * 是控件行为，不是配置项），照旧写成散文，跟在 Keys 里。
 */

import type { AppKeybindingDefinition } from '@/plugins/sph-tui/input/app-keybindings.js';
import type { CommandItem } from '@/plugins/sph-tui/commands/index.js';
import type { ReportBlock, ReportItem, ReportTab } from '@/plugins/sph-tui/report/doc.js';
import { oneLine } from '@/plugins/sph-tui/report/text.js';
import { formatKeyText } from '@/tui/input/keybindings.js';

export interface HelpTabsInput {
	commands: readonly CommandItem[];
	/** 别名 → 正名。别名不进正列，但必须能看见，否则靠旧名字找命令的人会以为它没了。 */
	aliases: Readonly<Record<string, string>>;
	keybindings: readonly AppKeybindingDefinition[];
}

/** 按注册表顺序把命令按组归桶（同一组的命令连续排列）。 */
function groupCommands(commands: readonly CommandItem[]): Map<string, CommandItem[]> {
	const groups = new Map<string, CommandItem[]>();
	for (const command of commands) {
		const bucket = groups.get(command.group) ?? [];
		bucket.push(command);
		groups.set(command.group, bucket);
	}
	return groups;
}

export function commandsTab(input: Pick<HelpTabsInput, 'commands' | 'aliases'>): ReportTab {
	const { commands, aliases } = input;
	const blocks: ReportBlock[] = [];

	for (const [group, bucket] of groupCommands(commands)) {
		const items: ReportItem[] = bucket.map((command): ReportItem => {
			const alias = Object.entries(aliases).find(([, canonical]) => canonical === command.id)?.[0];
			return {
				key: command.id,
				label: { text: command.label, tone: 'code', bold: true },
				description: oneLine(command.hint),
				// 别名放右列：它是「这条路也通」的注脚，不该挤占说明的空间。
				trailing: alias === undefined ? undefined : { text: `also /${alias}`, tone: 'muted' },
			};
		});
		blocks.push({ kind: 'group', group: { key: group, label: group, countNoun: 'commands', items } });
	}

	return { id: 'commands', label: 'Commands', blocks, empty: 'No commands match that.' };
}

export function keysTab(input: Pick<HelpTabsInput, 'keybindings'>): ReportTab {
	const blocks: ReportBlock[] = [];

	const keyGroups = new Map<string, AppKeybindingDefinition[]>();
	for (const definition of input.keybindings) {
		const bucket = keyGroups.get(definition.when) ?? [];
		bucket.push(definition);
		keyGroups.set(definition.when, bucket);
	}
	for (const [when, definitions] of keyGroups) {
		const items: ReportItem[] = definitions.map((definition): ReportItem => ({
			key: definition.keys.join('/'),
			label: { text: formatKeyText(definition.keys.join('/')), tone: 'code', bold: true },
			description: oneLine(definition.description),
		}));
		blocks.push({
			kind: 'group',
			group: { key: when, label: `Keys · ${when === 'always' ? 'available anytime' : when}`, countNoun: 'keys', items },
		});
	}

	// 鼠标与编辑器说明：本来就是散文（一条条拆开反而读不通），整段走 Markdown。
	blocks.push({
		kind: 'prose',
		text: [
			'**Queue (mouse)**',
			'',
			'- Hover a queued row for its [↑] [↓] [Send now] [edit] [cancel] buttons',
			'- Click a row to select it; [edit] takes it back to the input (queued order preserved)',
		].join('\n'),
	});
	blocks.push({
		kind: 'prose',
		text: [
			'**Editor**',
			'',
			'- `/` — slash-command autocomplete in the editor',
			'- Enter while a turn runs — queue the message (delivered after the turn ends)',
			'- Alt+Enter — queue a follow-up that starts after this turn',
		].join('\n'),
	});

	return { id: 'keys', label: 'Keys', blocks, empty: 'No keys match that.' };
}
