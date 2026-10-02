/**
 * 双击识别（组件自己坐标系里的手势判定）。
 *
 * 不能直接用框架给的 `event.clickCount`：那个计数来自文本选择路径，只有两次点击落在
 * 同一行的同一个词上才递增，点在块内右侧的空白背景上永远是 1。
 *
 * 这里改用组件自己的坐标系判断——时间窗口内、坐标邻近即算双击。代价是同一个 click
 * 事件必须只送到本组件一次，因此调用方要返回 `{ handled: true }` 阻止事件沿布局
 * box 链继续向上冒泡（否则一次点击会触发多次判定，双击会被自己抵消）。
 *
 * 放在 tui 层（而不是产品层）：工具行、工具组、报告面板的分组列表都用它，
 * 是控件层共用的手势件，和 `SUPPRESS_MULTI_CLICK_SELECTION` 同一类东西。
 */
export class DoubleClickTracker {
	private lastAt = 0;
	private lastX = Number.NaN;
	private lastY = Number.NaN;

	constructor(
		private readonly intervalMs = 500,
		private readonly slopX = 2,
		private readonly slopY = 1,
	) {}

	/**
	 * 记录本次点击位置，并返回它是否构成双击。
	 *
	 * 一旦判成双击就**清空序列**：否则三连击的第 3 下会跟第 2 下再配成一次双击，
	 * 开合被连翻两次（看着像没反应）。四连击因此读作「单击 + 双击」。
	 */
	accept(x: number, y: number): boolean {
		const now = Date.now();
		const isDouble =
			now - this.lastAt <= this.intervalMs &&
			Math.abs(x - this.lastX) <= this.slopX &&
			Math.abs(y - this.lastY) <= this.slopY;
		if (isDouble) {
			this.lastAt = 0;
			this.lastX = Number.NaN;
			this.lastY = Number.NaN;
			return true;
		}
		this.lastAt = now;
		this.lastX = x;
		this.lastY = y;
		return false;
	}
}
