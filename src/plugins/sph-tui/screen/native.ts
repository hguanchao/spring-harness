import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 可选的平台原生助手：剪贴板和修饰键。
 *
 * 找不到和 sph 放在一起的 .node 就退化（剪贴板不可用，修饰键视为没按下）。
 * 不按别的包名去 node_modules 里搜，否则屏幕实现会绑死在外部项目的安装布局上。
 */
export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
	return Array.from(
		new Set([
			join(moduleDir, "..", nativePath),
			join(moduleDir, nativePath),
			join(dirname(options.execPath ?? process.execPath), nativePath),
		]),
	);
}

const cjsRequire = createRequire(import.meta.url);

export type ModifierKey = "shift" | "command" | "control" | "option";

export interface NativeClipboard {
	/** Undefined means unavailable, null means no text; transfer failures reject. */
	getText(): Promise<string | null | undefined>;
	/** Undefined means unavailable, null means no image; transfer failures reject. */
	getImage(): Promise<Uint8Array | null | undefined>;
	/** Linux uses command-line tools to retain clipboard ownership instead. */
	setText?(text: string): Promise<void>;
}

type NativePlatformHelper = NativeClipboard & {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed?: (name: ModifierKey) => boolean;
};

// Cache module loading, not display availability: a disconnected display can recover.
const helpers = new Map<string, NativePlatformHelper | undefined>();

function loadNativePlatformHelper(platform: string, suffix = ""): NativePlatformHelper | undefined {
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;
	const nativePath = path.join(
		"native",
		platform,
		"prebuilds",
		`${platform}-${arch}`,
		`${platform}-platform${suffix}.node`,
	);
	if (helpers.has(nativePath)) return helpers.get(nativePath);

	for (const modulePath of getNativeModuleCandidates(nativePath)) {
		try {
			const helper = cjsRequire(modulePath) as Partial<NativePlatformHelper> | null;
			if (typeof helper?.getText === "function" && typeof helper.getImage === "function") {
				helpers.set(nativePath, helper as NativePlatformHelper);
				return helper as NativePlatformHelper;
			}
		} catch {
			// Try the next possible packaging location.
		}
	}
	helpers.set(nativePath, undefined);
	return undefined;
}

export function getNativePlatformHelper(): NativePlatformHelper | undefined {
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	return loadNativePlatformHelper(process.platform);
}

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = getNativePlatformHelper();
	if (!helper?.isModifierPressed) return false;
	try {
		return helper.isModifierPressed(key) === true;
	} catch {
		return false;
	}
}
