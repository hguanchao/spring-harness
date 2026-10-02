/**
 * 报告的展示文本工具。
 *
 * 这里只剩下与内容的**形状**有关的处理（压成一行、缩短主目录），不再有转义——
 * 报告改成结构数据之后，"内容里的反引号会不会破坏排版"这个问题从根上不存在了。
 */

/**
 * 压成一行：描述、警告、失败原因里的换行会把一条目撑成好几行，破坏"一条一行"的排版。
 * 折叠后的行高是算出来的，多一行就是多一行的高度。
 */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * 把用户级根路径里的主目录换成 `~`：弹窗一行装不下整条绝对路径，而用户级根一律在主目录下。
 *
 * 分隔符照原样保留，不假装它是 POSIX 路径——Windows 上 `~\skills` 虽然不好看，
 * 但比把 `\` 换成 `/` 更诚实。
 */
export function shortenRoot(path: string): string {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
