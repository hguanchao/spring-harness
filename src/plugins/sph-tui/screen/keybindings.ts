import { type KeyId, matchesKey } from "./keys.js";

/**
 * Global keybinding registry.
 * Downstream packages can add keybindings via declaration merging.
 */
export interface Keybindings {
	// Editor navigation and editing
	"tui.editor.cursorUp": true;
	"tui.editor.cursorDown": true;
	"tui.editor.historyPrevious": true;
	"tui.editor.historyNext": true;
	"tui.editor.cursorLeft": true;
	"tui.editor.cursorRight": true;
	"tui.editor.cursorWordLeft": true;
	"tui.editor.cursorWordRight": true;
	"tui.editor.cursorLineStart": true;
	"tui.editor.cursorLineEnd": true;
	"tui.editor.pageUp": true;
	"tui.editor.pageDown": true;
	"tui.editor.deleteCharBackward": true;
	"tui.editor.deleteCharForward": true;
	"tui.editor.deleteWordBackward": true;
	"tui.editor.deleteWordForward": true;
	"tui.editor.deleteToLineStart": true;
	"tui.editor.deleteToLineEnd": true;
	"tui.editor.yank": true;
	"tui.editor.undo": true;
	// Generic input actions
	"tui.input.newLine": true;
	"tui.input.submit": true;
	"tui.input.tab": true;
	"tui.input.copy": true;
	// Generic selection actions
	"tui.select.up": true;
	"tui.select.down": true;
	"tui.select.pageUp": true;
	"tui.select.pageDown": true;
	"tui.select.confirm": true;
	"tui.select.cancel": true;
	// Alternate-screen viewport navigation
	"tui.altScreen.pageUp": true;
	"tui.altScreen.pageDown": true;
	"tui.altScreen.previousPrompt": true;
	"tui.altScreen.nextPrompt": true;
	"tui.altScreen.top": true;
	"tui.altScreen.bottom": true;
}

export type Keybinding = keyof Keybindings;

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.historyPrevious": {
		defaultKeys: [],
		description: "Select previous prompt history entry",
	},
	"tui.editor.historyNext": {
		defaultKeys: [],
		description: "Select next prompt history entry",
	},
	"tui.editor.cursorLeft": {
		defaultKeys: ["left", "ctrl+b"],
		description: "Move cursor left",
	},
	"tui.editor.cursorRight": {
		defaultKeys: ["right", "ctrl+f"],
		description: "Move cursor right",
	},
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.pageUp": { defaultKeys: ["pageUp", "ctrl+pageUp"], description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: ["pageDown", "ctrl+pageDown"], description: "Page down" },
	"tui.editor.deleteCharBackward": {
		defaultKeys: "backspace",
		description: "Delete character backward",
	},
	"tui.editor.deleteCharForward": {
		defaultKeys: ["delete", "ctrl+d"],
		description: "Delete character forward",
	},
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": {
		defaultKeys: ["alt+d", "alt+delete"],
		description: "Delete word forward",
	},
	"tui.editor.deleteToLineStart": {
		defaultKeys: "ctrl+u",
		description: "Delete to line start",
	},
	"tui.editor.deleteToLineEnd": {
		defaultKeys: "ctrl+k",
		description: "Delete to line end",
	},
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": {
		defaultKeys: "pageDown",
		description: "Selection page down",
	},
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": {
		defaultKeys: ["escape", "ctrl+c"],
		description: "Cancel selection",
	},
	"tui.altScreen.pageUp": {
		defaultKeys: "pageUp",
		description: "Scroll viewport up one page",
	},
	"tui.altScreen.pageDown": {
		defaultKeys: "pageDown",
		description: "Scroll viewport down one page",
	},
	"tui.altScreen.previousPrompt": {
		defaultKeys: ["ctrl+shift+up", "ctrl+up"],
		description: "Jump to previous semantic prompt",
	},
	"tui.altScreen.nextPrompt": {
		defaultKeys: ["ctrl+shift+down", "ctrl+down"],
		description: "Jump to next semantic prompt",
	},
	"tui.altScreen.top": { defaultKeys: "home", description: "Scroll viewport to top" },
	"tui.altScreen.bottom": { defaultKeys: "end", description: "Scroll viewport to bottom" },
} as const satisfies KeybindingDefinitions;

function normalizeKeys(keys: KeyId | KeyId[] | undefined): KeyId[] {
	if (keys === undefined) return [];
	const keyList = Array.isArray(keys) ? keys : [keys];
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keyList) {
		if (!seen.has(key)) {
			seen.add(key);
			result.push(key);
		}
	}
	return result;
}

export class KeybindingsManager {
	private keysById = new Map<Keybinding, KeyId[]>();

	constructor(definitions: KeybindingDefinitions) {
		for (const [id, definition] of Object.entries(definitions)) {
			this.keysById.set(id as Keybinding, normalizeKeys(definition.defaultKeys));
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.keysById.get(keybinding) ?? [])];
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}

/** 键位文案，例如 "Ctrl+O"；darwin 上 alt 显示为 Option。多键用 `/` 连接。 */
export function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => {
					const lower = part.toLowerCase();
					const display = process.platform === "darwin" && lower === "alt" ? "option" : lower;
					return display.charAt(0).toUpperCase() + display.slice(1);
				})
				.join("+"),
		)
		.join("/");
}
