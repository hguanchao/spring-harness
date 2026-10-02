/**
 * Permissions tab 的数据构造。
 *
 * 号就是求值顺序：`compileLayers` 给出的次序（deny 用户级→项目级，再 ask，最后 allow，
 * 先命中先定论）。按层分两段列是原来那种「读的人自己脑内合并」，而「我这条怎么没生效」
 * 的答案恰恰落在合并之后的位次上——所以编号进 label，并被「#N ignored」的诊断句直接引用。
 * 编号不能交给列表的号槽：号槽按「可选行里的第几条」算，搜索一次编号就漂，等于给了个假信息。
 */

import { compileLayers, type RuleLayers } from '@/permission/policy.js';
import type { ReportBlock, ReportItem, ReportTab } from '@/plugins/sph-tui/report/doc.js';

export interface PermissionsTabInput {
	approval: string;
	sandboxMode: string;
	sandboxAutoAllow: boolean;
	layers: RuleLayers;
	/** 用户级配置文件的落点（用户级规则写在这里）。 */
	userConfigPath: string;
	projectPath: string;
	projectAllowDropped: boolean;
	approved: readonly string[];
	grantsPath: string;
	/** 授权文件读不回来时的原因；橙字收尾，读不到授权比少几条更要紧。 */
	grantWarning?: string;
}

export function permissionsTab(input: PermissionsTabInput): ReportTab {
	const blocks: ReportBlock[] = [];
	const compiled = compileLayers(input.layers);

	// 模式与沙箱是「当下生效的策略」：条目化之后与规则共用一套导航与搜索。
	blocks.push({
		kind: 'group',
		group: {
			key: 'policy',
			label: 'Policy',
			collapsible: false,
			items: [
				{ key: 'approval', label: 'Approval mode', description: input.approval },
				{
					key: 'sandbox',
					label: 'Sandbox',
					description: `${input.sandboxMode}${input.sandboxAutoAllow ? ' — shell commands inside the sandbox are not asked' : ''}`,
				},
			],
		},
	});

	// 规则组常驻：没有规则时 `(0 rules)` 本身就是要回答的事——比一句游离的说明明确，
	// 也与下面 `Approved actions (0 actions)` 同一个读法。
	const rules: ReportItem[] = compiled.map((entry, index): ReportItem => ({
		key: `rule-${index + 1}`,
		label: [{ text: `${index + 1}. ` }, { text: entry.action, tone: 'code' }, { text: ` — ${entry.raw}` }],
		// 来源作右列：核对「这条写在哪个文件」是灰色的次要信息。
		trailing: { text: entry.layerKey, tone: 'muted' },
	}));
	blocks.push({
		kind: 'group',
		group: { key: 'rules', label: 'Rules · evaluated in this order', countNoun: 'rules', collapsible: false, items: rules },
	});
	if (input.projectAllowDropped) {
		const dropped = compiled
			.map((entry, index) => (entry.layerKey === 'project' && entry.action === 'allow' ? index + 1 : 0))
			.filter((number) => number > 0);
		if (dropped.length > 0) {
			// 橙色：这是一条「你写的规则没生效」的诊断，不是普通说明。
			blocks.push({
				kind: 'caption',
				text: {
					text: `${dropped.map((number) => `#${number}`).join(', ')} ignored — this workspace is not trusted (deny / ask still apply).`,
					tone: 'warn',
				},
			});
		}
	}

	// 这个 tab 读哪些文件：三层同粒度都是**文件路径**（从前用户级给目录、项目级给文件，
	// grants 还另占一句游离说明）。grants 不是规则层，但它是同一类事实——「东西存在哪」。
	blocks.push({
		kind: 'group',
		group: {
			key: 'sources',
			label: 'Sources',
			collapsible: false,
			// 键是行标签（正文色，与 Policy 那两行同一个画法），要照抄的是**取值**里的路径 → 蓝。
			items: [
				{ key: 'user', label: 'user', description: { text: input.userConfigPath || '(none)', tone: 'code' } },
				{ key: 'project', label: 'project', description: { text: input.projectPath, tone: 'code' } },
				{ key: 'grants', label: 'grants', description: { text: input.grantsPath, tone: 'code' } },
			],
		},
	});


	const approved = input.approved.slice(0, 20).map((key): ReportItem => ({ key, label: key }));
	if (input.approved.length > 20) {
		approved.push({ key: '::more', label: { text: `… ${input.approved.length - 20} more`, tone: 'muted' } });
	}
	blocks.push({
		kind: 'group',
		group: { key: 'approved', label: 'Approved actions', countNoun: 'actions', items: approved },
	});

	if (input.grantWarning !== undefined) {
		blocks.push({ kind: 'caption', text: { text: input.grantWarning, tone: 'warn' } });
	}

	return {
		id: 'permissions',
		label: 'Permissions',
		blocks,
		empty: 'Nothing in this report matches that.',
	};
}
