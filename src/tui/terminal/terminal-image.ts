import { execSync } from "node:child_process";

/**
 * 这台终端接受哪一种桌面通知 OSC。
 *
 * 只有四类合法答案：`osc9`（iTerm2 / Windows Terminal / WezTerm / Ghostty 等）、
 * `osc777`（rxvt-unicode 系）、`osc99`（kitty）、`none`（写了也没人接）。
 */
export type NotificationChannel = "osc9" | "osc777" | "osc99" | "none";

export interface TerminalCapabilities {
	hyperlinks: boolean;
	notifications: NotificationChannel;
}

let cachedCapabilities: TerminalCapabilities | null = null;
const capabilityOverrides: Partial<TerminalCapabilities> = {};

/**
 * Checks whether the attached tmux client forwards OSC 8 hyperlinks to the
 * outer terminal. tmux only re-emits them when its `client_termfeatures` lists
 * `hyperlinks`, and strips them otherwise. On any error fallbacks `false`.
 */
function probeTmuxHyperlinks(): boolean {
	try {
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return termfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

function detectHyperlinksFromEnvironment(tmuxForwardsHyperlink: () => boolean): boolean {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";

	if (process.env.TMUX || term.startsWith("tmux")) return tmuxForwardsHyperlink();
	if (term.startsWith("screen")) return false;
	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") return true;
	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) return true;
	if (process.env.WEZTERM_PANE || termProgram === "wezterm") return true;
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) return true;
	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") return true;
	if (process.env.WT_SESSION) return true;
	if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") return true;
	if (terminalEmulator === "jetbrains-jediterm") return false;
	if (process.platform === "win32") return false;
	return false;
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

/**
 * 桌面通知通道的判定。
 *
 * 与超链接同一套环境变量线索，因为「这台终端认不认通知 OSC」基本就是终端家族的问题。
 * 复用 detectHyperlinksFromEnvironment 里已经列出的那几个变量，避免两处对终端的说法不一致。
 *
 * tmux / screen 一律算 `none`：它们不会把未知 OSC 原样转发给外层终端。
 * 优先级：显式环境变量 > kitty（自成一套 OSC 99）> urxvt > 其余认 OSC 9 的家族 > none。
 */
export function detectNotificationChannelFromEnvironment(env: NodeJS.ProcessEnv = process.env): NotificationChannel {
	const termProgram = env.TERM_PROGRAM?.toLowerCase() || "";
	const term = env.TERM?.toLowerCase() || "";
	if (env.TMUX || term.startsWith("tmux") || term.startsWith("screen")) return "none";
	if (env.KITTY_WINDOW_ID || termProgram === "kitty") return "osc99";
	if (termProgram === "warpterminal" || env.WARP_SESSION_ID || env.WARP_TERMINAL_SESSION_UUID) return "none";
	if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") return "none";
	if (term.includes("rxvt") || termProgram === "urxvt") return "osc777";
	// 这些家族都接 OSC 9；接不了也只是被忽略，写错方向的代价是一行没弹，而不是画面上多出乱码。
	if (env.WT_SESSION || env.ITERM_SESSION_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR) return "osc9";
	if (termProgram === "iterm.app" || termProgram === "wezterm" || termProgram === "ghostty") return "osc9";
	return "none";
}

export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const override = parseBooleanCapabilityOverride(process.env.SPH_HYPERLINKS);
	return {
		hyperlinks: override ?? detectHyperlinksFromEnvironment(tmuxForwardsHyperlink),
		notifications: detectNotificationChannelFromEnvironment(),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		cachedCapabilities = {
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			...capabilityOverrides,
		};
	}
	return cachedCapabilities;
}

export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * Terminals that do not support OSC 8 ignore the sequences and show the plain text.
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
