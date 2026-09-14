import { execSync } from "node:child_process";

export interface TerminalCapabilities {
	hyperlinks: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};

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

export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const override = parseBooleanCapabilityOverride(process.env.SPH_HYPERLINKS);
	return {
		hyperlinks: override ?? detectHyperlinksFromEnvironment(tmuxForwardsHyperlink),
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
