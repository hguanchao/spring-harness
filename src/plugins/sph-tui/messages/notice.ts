/**
 * Notice 块：系统口信（`Model set to …`、`Queued follow-up (3)`、启动警告……）。
 *
 * 排版是「── 文字 ──」居中提示块（只占半行），而不是左对齐的一句话：后者夹在助手回复里会被
 * 读成正文的一部分，而它其实是**系统在说话**——一条事件就该长得像一条事件。
 *
 * **文字一律中性灰（dim），不看等级**：口信是通知，不该用颜色去跟正文、工具行抢注意力。
 * 等级仍然从 `api.notify(message, level)` 一路传进来，只是当前不参与表现——它是插件 API 的
 * 词汇表，收下它比改契约便宜（见 addNotice 的注释）。
 *
 * 装不下（长警告）时退回左对齐折行——把长句居中截断比不画线更难读。判断在
 * {@link centeredRuleLine} 里，这里只做回退。
 *
 * 体型只有这一种：曾经试过给"设置回执"加一种更轻的平铺体型（左对齐、不画线），结论是
 * **不该显示的直接不发**，而不是换个体型再发一遍。所以这里不再有体型选项。
 */

import { type Component, wrapTextWithAnsi } from '@/tui/index.js';
import { centeredRuleLine } from '@/tui/text/utils.js';
import { theme } from '@/plugins/sph-tui/theme/theme.js';

/** 口信等级：插件 API（`api.notify`）的词汇表，UI 侧当前不区分表现。 */
export type NoticeLevel = 'dim' | 'warn' | 'error' | 'success';

export class NoticeComponent implements Component {
	/**
	 * `_level` 只跟着走、不参与表现：留着它，一是与 `addNotice(text, level)` 同形，
	 * 二是恢复分等级表现时改这一处就够（见文件头）。前导下划线是"故意不用"的记号。
	 */
	constructor(
		private readonly text: string,
		_level: NoticeLevel = 'dim',
	) {}

	invalidate(): void {
		// 每帧按当前宽度现算，没有缓存可清。
	}

	render(width: number): string[] {
		const body = theme.fg('dim', this.text);
		const line = centeredRuleLine(body, width, (rule) => theme.fg('borderMuted', rule));
		// 装不下（长警告）：退回平铺折行，线不画。折行保留那一格左内缩，与纯文本时的左缘一致。
		return line === undefined ? wrapTextWithAnsi(` ${body}`, width) : [line];
	}
}
