/**
 * 行级悬停高亮的共享清臂机制。
 *
 * 单光标同一时刻至多悬停一行，全局只记一个「清除函数」：每次鼠标移动先
 * clearHoverHighlight() 清掉上一行的高亮，命中行的 move 处理器再 armHoverHighlight()
 * 重新点亮——同帧内一清一亮，不需要任何绝对坐标。调用方必须把 clear 挂在
 * TUI.onMouseMotion（它先于组件分发执行），顺序才成立。
 */

let clearActive: (() => boolean) | undefined;

/** 记录当前悬停行的清除函数（组件自持状态，只暴露「清了有没有变化」）。 */
export function armHoverHighlight(clear: () => boolean): void {
  clearActive = clear;
}

/** 清除当前悬停高亮。返回是否有变化（调用方据此决定要不要重绘）。 */
export function clearHoverHighlight(): boolean {
  const clear = clearActive;
  clearActive = undefined;
  return clear ? clear() : false;
}
