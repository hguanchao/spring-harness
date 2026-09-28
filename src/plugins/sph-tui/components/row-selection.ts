/**
 * 转录里工具行 / 思考行的选中。
 *
 * 悬停是瞬时的（见 hover-highlight），选中留下来：点一行就换到这一行，
 * 同一时刻只有一行选中，这样悬停和选中可以同时出现在两行上。
 */

import { theme, type ThemeColor } from '../theme/theme.js';

let activeClear: (() => boolean) | undefined;
/** 这一下 click 有没有落到工具行 / 思考行上。点在别处就要清掉选中。 */
let clickClaimsSelection = false;

/** 每次左键 click 分发前调用，避免上一次的选中标记串到这一下。 */
export function beginTranscriptClick(): void {
  clickClaimsSelection = false;
}

/** 选中这一行，并清掉上一行。同一行再点一次不重复刷。 */
export function selectTranscriptRow(clear: () => boolean): void {
  clickClaimsSelection = true;
  if (activeClear === clear) return;
  const previous = activeClear;
  activeClear = clear;
  previous?.();
}

/** click 分发后调用。没有行认领这次点击时清掉选中。返回是否真的清掉了。 */
export function finishTranscriptClick(): boolean {
  if (clickClaimsSelection) {
    clickClaimsSelection = false;
    return false;
  }
  const previous = activeClear;
  if (!previous) return false;
  activeClear = undefined;
  return previous();
}

/** 选中盖过悬停：选中行被悬停时仍用选中色，离开后也不会掉回空白。 */
export function rowChromeBg(selected: boolean, hovered: boolean): ((text: string) => string) | undefined {
  const color: ThemeColor | undefined = selected ? 'rowSelectedBg' : hovered ? 'rowHoverBg' : undefined;
  if (!color) return undefined;
  return (text) => theme.bg(color, text);
}
