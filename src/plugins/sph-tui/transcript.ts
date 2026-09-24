/**
 * agent 事件 → 转录渲染的投影。
 *
 * 职责边界：凡是「往转录里画东西」（助手流式块、思考链、工具分组、子代理实时行与
 * 底部 dock、pending 工具行）都归这里；事件分派、状态行活动词、标题采样仍归交互
 * 模式（宿主）——那几样横跨转录与 dock，还需要读宿主的 activityLabel。
 *
 * 事件分派（listener）在宿主，每类事件调这里的一个入口方法；投影内部自持状态，
 * 不反查宿主字段，保证两块可以独立演进。
 */

import type { SubagentEvent } from '../sph-loop/events.js';
import { flattenWhitespace, formatDuration } from '../../util.js';
import { Text } from '../../tui/index.js';
import type { Container, TUI, VStack } from '../../tui/index.js';
import { AssistantMessageComponent } from './components/assistant-message.js';
import { SubagentTaskComponent } from './components/subagent-task.js';
import { WorkingLabel } from './components/interaction.js';
import { ToolGroupComponent } from './components/tool-group.js';
import {
  TOOL_GROUP_INDENT,
  TOOL_MEMBER_INDENT,
  ToolExecutionComponent,
  summarizeArgs,
  toolDisplayName,
} from './components/tool-execution.js';
import { getMarkdownTheme, theme } from './theme/theme.js';

/** 输入框上方子代理栏最多显示几行，多出来的折成 `… N more`。 */
const MAX_DOCK_SUBAGENT_ROWS = 5;

/** 投影需要的宿主能力：容器、渲染通道分流与兜底通知。 */
export interface TranscriptHost {
  ui: TUI;
  /** 聊天流（用户块/助手块/工具组/通知行的父容器）。 */
  chatContainer: VStack;
  /** 状态行上方的 pending 工具行容器。 */
  pendingContainer: Container;
  /** 输入框上方的子代理 dock 容器与段头文本。 */
  subagentContainer: Container;
  subagentHeader: Text;
  /** 事件引起的可见变化：转录区与 dock 走不同渲染通道。 */
  paint(kind: 'transcript' | 'dock'): void;
  /** 异常时序/老会话回放兜底的独立通知行。 */
  addNotice(text: string, level?: 'dim' | 'warn' | 'error' | 'success'): void;
}

/**
 * 子代理内部事件 → 行内活动段文案，与底部状态行共用同一套词（WorkingLabel）。
 *
 * 返回 undefined 表示这个事件不改变活动段（`tool_end` / `status` / `thinking_start` 不改）。
 * thinking_start 每轮都会发，但很多端点不吐 reasoning，不能一开就切到 Thinking…。
 */
function subagentActivity(event: SubagentEvent): string | undefined {
  switch (event.type) {
    case 'thinking_delta':
      return WorkingLabel.thinking;
    case 'thinking_end':
      return WorkingLabel.working;
    case 'text':
      return WorkingLabel.responding;
    case 'tool_start':
      return WorkingLabel.running(toolDisplayName(event.name), summarizeArgs(event.name, event.args));
    case 'error':
      return flattenWhitespace(event.text).slice(0, 80);
    default:
      return undefined;
  }
}

export class TranscriptProjection {
  private streamingAssistant?: AssistantMessageComponent;
  private thinkingId?: string;
  /**
   * 承载当前思考链的工具分组。
   *
   * 思考期间可能插进正文（`thinking_end` 在正文之后才广播），而正文会断开当前分组，
   * 所以收尾时不能重新 `ensureToolGroup()`——认住开始时那个组，同一段推理才不会被劈成两半。
   */
  private thinkingGroup?: ToolGroupComponent;
  /** 本段思考链的起点，用来给收尾文案算 `Thought for 1.2s`。 */
  private thinkingStartedAt?: number;
  private thinkingBuffer = '';
  /**
   * 本轮模型是否已经真正响应（思考/正文/工具）。
   * 不能用「助手组件是否已创建」代替：`thinking_start` 在请求发出前就会广播。
   * stream_retry 会丢掉半截画面，但一旦响应过就不能再把原文塞回输入框
   * 一旦已经有过响应，就不能再把原文塞回输入框。
   */
  private modelRespondedFlag = false;
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private readonly toolGroups: ToolGroupComponent[] = [];
  /** 当前正在累积的工具分组；助手正文/通知/轮次结束都会把它断开。 */
  private activeToolGroup?: ToolGroupComponent;
  /** 本组内 subagent 调用的序号（行首的 `Subagent 1`）；分组断开时归零。 */
  private subagentOrdinal = 0;
  /**
   * 子代理 id → 主流程里对应的 Task 工具行 + 转录内实时任务块。
   *
   * 子代理的内部活动（工具调用、错误）实时刷进任务块，聚合结果在
   * subagent_end 时写到 Task 行的活动后缀上，随后任务块整块撤除、不在时间线常驻。
   * 后台任务的工具行在 job id 返回时就已完成，所以这里独立于 pendingTools 持有引用。
   */
  private readonly subagentLines = new Map<
    string,
    {
      tool: ToolExecutionComponent;
      description: string;
      toolCallId?: string;
      background: boolean;
      /** 回放路径不建实时块（内部调用明细不落主会话），只有汇总。 */
      live?: SubagentTaskComponent;
    }
  >();
  private readonly pendingToolLines = new Map<string, Text>();

  constructor(private readonly host: TranscriptHost) {}

  /** 本轮模型是否已真正响应；中断回填（rewind）与否的判定依据。 */
  get modelResponded(): boolean {
    return this.modelRespondedFlag;
  }

  /** 仍在跑的实时子代理行数（轮次收尾提醒与 recap 资格判定用）。 */
  get liveSubagentCount(): number {
    return this.subagentLines.size;
  }

  /** 新一轮开始：上一轮的响应状态作废（其余渲染状态保持，中断重试依赖它们）。 */
  beginTurn(): void {
    this.modelRespondedFlag = false;
  }

  // ------------------------------------------------------------------ 思考链

  /**
   * stream_retry：丢掉半截思考与正文后重新开一段思考链。
   * 采样里的半截正文由宿主清（titleDraft 是宿主状态）。
   */
  restartThinking(): void {
    this.thinkingGroup?.dropStreamingThinking();
    this.thinkingBuffer = '';
    this.thinkingStartedAt = Date.now();
    this.thinkingGroup?.beginThinking();
  }

  /** 丢掉流式中的助手段（stream_retry 会用重试后的新文本从头画）。 */
  dropStreamingAssistant(): void {
    if (this.streamingAssistant) {
      this.host.chatContainer.removeChild(this.streamingAssistant);
      this.streamingAssistant = undefined;
    }
  }

  beginThinking(id: string): void {
    this.thinkingId = id;
    this.thinkingBuffer = '';
    this.thinkingStartedAt = Date.now();
    // 不在 start 切 Thinking…：无 reasoning 的工具轮次永远等不到 delta，状态行会假死。
    // 压缩刚结束时要把 Folding context… 收回去，否则会一直挂到第一条 delta（宿主职责）。
    this.thinkingGroup = this.ensureToolGroup();
    this.thinkingGroup.beginThinking();
  }

  /** 思考增量；返回该增量是否属于当前思考链（命中时宿主才切 Thinking… 活动词）。 */
  appendThinking(id: string, text: string): boolean {
    if (id !== this.thinkingId) return false;
    this.modelRespondedFlag = true;
    this.thinkingBuffer += text;
    this.thinkingGroup?.setThinking(this.thinkingBuffer, true);
    return true;
  }

  /**
   * 思考链收尾。content 是权威全文；只有它为空的异常路径（思考中途报错，loop 补发
   * content: ''）才回落到已经流出的增量，别把用户已经看到的推理丢掉。
   */
  endThinking(id: string, content: string): void {
    if (id !== this.thinkingId) return;
    // 正文先于 thinking_end 到达，所以这里必须认住开始时那个组，而不是重新 ensureToolGroup——
    // 中途的 text 已经断开旧组，重新取会新开一个组，把同一段推理劈成两半。
    const full = content !== '' ? content : this.thinkingBuffer;
    this.thinkingGroup?.setThinking(full, false, this.thinkingElapsed());
    this.thinkingGroup = undefined;
    this.thinkingStartedAt = undefined;
    this.thinkingBuffer = '';
    this.thinkingId = undefined;
  }

  /** 本段思考链已耗时；没记到起点时返回 undefined（收尾文案退化成 `Thought`）。 */
  private thinkingElapsed(): number | undefined {
    return this.thinkingStartedAt === undefined ? undefined : Date.now() - this.thinkingStartedAt;
  }

  // ------------------------------------------------------------------ 助手正文与工具

  /** 追加一段流式正文（首段先建助手组件）。 */
  appendAssistantText(text: string): void {
    const assistant = this.ensureAssistant();
    assistant.appendText(text);
  }

  /** 模型发起了工具调用：切断助手段，工具行进当前分组。 */
  startTool(id: string, name: string, args: Record<string, unknown>): void {
    this.modelRespondedFlag = true;
    // 工具活动切断当前助手段：下一个 thinking/text 事件经 ensureAssistant 在工具组
    // 下方新起组件。否则整轮文字都挤进轮首那个组件里，最终总结会排在工具汇总之上，
    // 变成「全部回答在上、工具组沉底」——时间线要按真实顺序交错。
    this.streamingAssistant?.setStreaming(false);
    this.streamingAssistant = undefined;
    const tool = new ToolExecutionComponent(name, id, args, this.host.ui);
    tool.markExecutionStarted();
    this.ensureToolGroup().addTool(tool);
    this.pendingTools.set(id, tool);
    // subagent 的实时进度由转录内任务块承担，不进底部「正在跑」区。
    if (name !== 'subagent') this.addPendingToolLine(id, name, args);
  }

  /** 工具收尾：结果写进对应行；找不到（异常时序）只清 pending 提示行。 */
  endTool(id: string, content: string, ok: boolean): void {
    const tool = this.pendingTools.get(id);
    if (tool) {
      tool.updateResult({ content, isError: !ok });
      this.pendingTools.delete(id);
    }
    this.removePendingToolLine(id);
  }

  private ensureAssistant(): AssistantMessageComponent {
    if (!this.streamingAssistant) {
      this.breakToolGroup();
      const assistant = new AssistantMessageComponent({ markdownTheme: getMarkdownTheme() });
      assistant.setStreaming(true);
      this.host.chatContainer.addChild(assistant);
      this.streamingAssistant = assistant;
    }
    return this.streamingAssistant;
  }

  /** 取当前工具分组；没有就新建一个挂到对话流末尾。 */
  ensureToolGroup(): ToolGroupComponent {
    if (!this.activeToolGroup) {
      const group = new ToolGroupComponent(this.host.ui);
      this.host.chatContainer.addChild(group);
      this.toolGroups.push(group);
      this.activeToolGroup = group;
    }
    return this.activeToolGroup;
  }

  /** 断开当前分组：下一个工具调用会另起一组，子代理序号也跟着从头数。 */
  breakToolGroup(): void {
    this.activeToolGroup = undefined;
    this.subagentOrdinal = 0;
  }

  /** 整批展开/收起工具分组（⇧O 循环开关）：以「存在任一展开组」为状态翻转点。 */
  toggleToolExpansion(): void {
    const expand = !this.toolGroups.some((group) => group.isExpanded());
    for (const group of this.toolGroups) group.setExpanded(expand, false);
    this.host.ui.invalidateContent();
  }

  /** 轮次收尾：停流式、落思考链、撤 pending 工具行。 */
  finalizeStreaming(): void {
    this.breakToolGroup();
    if (this.streamingAssistant) {
      this.streamingAssistant.setStreaming(false);
      this.streamingAssistant = undefined;
    }
    // 轮次可能在思考中途收尾（中断/异常），此时 thinking_end 不会再来：主动把成员从
    // 「运行中」落下，否则转录里会永远留着一行 Thinking…，而且它还会一直占着行不折叠。
    this.thinkingGroup?.setThinking(this.thinkingBuffer, false, this.thinkingElapsed());
    this.thinkingBuffer = '';
    this.thinkingId = undefined;
    this.thinkingStartedAt = undefined;
    this.thinkingGroup = undefined;
    for (const line of this.pendingToolLines.values()) this.host.pendingContainer.removeChild(line);
    this.pendingToolLines.clear();
  }

  /** 轮次收尾兜底：清空还没等到 tool_end 的工具行映射（中断/异常时不会再有 tool_end）。 */
  clearPendingTools(): void {
    this.pendingTools.clear();
  }

  /** 换会话/新建时清空转录投影状态（与原 clearChat 的清理范围逐项一致）。 */
  clear(): void {
    this.toolGroups.length = 0;
    this.activeToolGroup = undefined;
    this.pendingTools.clear();
    this.streamingAssistant = undefined;
  }

  // ------------------------------------------------------------------ pending 工具行

  private addPendingToolLine(id: string, name: string, args: Record<string, unknown>): void {
    const detail = typeof args.command === 'string' ? args.command : (typeof args.path === 'string' ? args.path : '');
    const oneLine = flattenWhitespace(`${name}${detail ? ` ${detail}` : ''}`).slice(0, 100);
    const text = new Text(theme.fg('muted', `  ${oneLine}`), 0, 0);
    this.host.pendingContainer.addChild(text);
    this.pendingToolLines.set(id, text);
  }

  private removePendingToolLine(id: string): void {
    const line = this.pendingToolLines.get(id);
    if (line) {
      this.host.pendingContainer.removeChild(line);
      this.pendingToolLines.delete(id);
    }
  }

  // ------------------------------------------------------------------ 子代理

  /**
   * 子代理开始：活动归并到主流程的 Task 工具行上（单行实时摘要），
   * 并在输入框上方挂实时任务块（跑完即撤，不常驻）。
   * 返回是否挂上了工具行——false 时宿主退回独立通知（找不到 Task 行的异常时序）。
   */
  startSubagent(meta: {
    id: string;
    toolCallId?: string;
    childType?: string;
    background: boolean;
    description: string;
  }): boolean {
    const tool = meta.toolCallId ? this.pendingTools.get(meta.toolCallId) : undefined;
    if (!tool) return false;
    const index = ++this.subagentOrdinal;
    tool.attachSubagentMeta({ index, childType: meta.childType, background: meta.background, description: meta.description });
    // 实时进度挂到输入框上方那一栏（跑完即撤，不常驻）；转录里留下的是同一行首文案的
    // 完成摘要，dock 带类型，转录行只要序号+描述+耗时。
    const live = new SubagentTaskComponent(this.host.ui, {
      index,
      childType: meta.childType,
      background: meta.background,
      description: meta.description,
    });
    this.subagentLines.set(meta.id, {
      tool,
      description: meta.description,
      toolCallId: meta.toolCallId,
      background: meta.background,
      live,
    });
    this.refreshDock();
    return true;
  }

  /**
   * 子代理收尾：转录行只留 `Subagent N 描述 · 总耗时`，实时 dock 行撤掉。
   * 返回是否找到了对应行——false 时宿主退回独立通知。
   */
  finishSubagent(id: string, ok: boolean, durationMs: number, summary: string, _tokens?: number): boolean {
    const entry = this.subagentLines.get(id);
    if (!entry) return false;
    entry.live?.dispose();
    // 报告写进工具详情：否则双击展开没有正文（尤其后台任务 tool_end 只是 job 回执）。
    const report = summary.trim();
    if (report !== '') entry.tool.updateResult({ content: report, isError: !ok });
    if (ok) entry.tool.setActivity(formatDuration(durationMs));
    else entry.tool.setActivity(`FAILED: ${flattenWhitespace(summary).slice(0, 100)}`, true);
    this.subagentLines.delete(id);
    this.refreshDock();
    return true;
  }

  /** 子代理内部事件转发：实时刷进任务块，找不到行时退回独立通知。 */
  onSubagentEvent(id: string, event: SubagentEvent): void {
    const entry = this.subagentLines.get(id);
    if (!entry) {
      // 行没建出来（异常时序/老会话回放）：退回独立行，至少不让子活动凭空消失。
      if (event.type === 'tool_start') this.host.addNotice(`  ↳ ${event.name}`, 'dim');
      else if (event.type === 'error') this.host.addNotice(`  ↳ ${event.text}`, 'error');
      if (event.type === 'tool_start' || event.type === 'error') this.host.paint('transcript');
      return;
    }
    if (event.type === 'usage') {
      entry.live?.addTokens(event.promptTokens + event.completionTokens);
      this.host.paint('dock');
      return;
    }
    const activity = subagentActivity(event);
    if (activity !== undefined) entry.live?.setActivity(activity, event.type === 'error');
    this.host.paint('dock');
  }

  /**
   * 刷新输入框上方的子代理栏：段头 + 每个运行中的子代理一行。
   *
   * 位置在工作状态提示之上（参考实现 dock 的位置）：转录只留完成摘要，实时进度全在这里，
   * 跑完即撤。行数超上限就截断，免得 dock 把转录区挤没。
   */
  private refreshDock(): void {
    this.host.subagentContainer.clear();
    const rows = [...this.subagentLines.values()]
      .map((entry) => entry.live)
      .filter((live) => live !== undefined);
    if (rows.length === 0) return;

    const shown = rows.slice(0, MAX_DOCK_SUBAGENT_ROWS);
    this.host.subagentHeader.setText(`${' '.repeat(TOOL_GROUP_INDENT)}${theme.fg('dim', `Subagents ${rows.length}`)}`);
    this.host.subagentContainer.addChild(this.host.subagentHeader);
    for (const row of shown) this.host.subagentContainer.addChild(row);
    if (rows.length > shown.length) {
      this.host.subagentContainer.addChild(
        new Text(`${' '.repeat(TOOL_MEMBER_INDENT)}${theme.fg('dim', `… ${rows.length - shown.length} more`)}`, 0, 0),
      );
    }
  }

  // ------------------------------------------------------------------ 会话回放支持

  /** 回放一条助手消息的工具调用：建行、进组、挂进 pending（结果由后续 tool 消息回填）。 */
  beginReplayedTool(name: string, id: string, args: Record<string, unknown>): void {
    const tool = new ToolExecutionComponent(name, id, args, this.host.ui);
    tool.markExecutionStarted();
    this.ensureToolGroup().addTool(tool);
    this.pendingTools.set(id, tool);
  }

  /** 回放一条 tool 结果消息：优先归位到 pending 行，孤儿结果独立成行。 */
  replayToolResult(toolCallId: string | undefined, toolName: string | undefined, content: string): void {
    const tool = toolCallId ? this.pendingTools.get(toolCallId) : undefined;
    if (tool) {
      tool.updateResult({ content, isError: false });
      if (toolCallId) this.pendingTools.delete(toolCallId);
      return;
    }
    const standalone = new ToolExecutionComponent(toolName ?? 'tool', toolCallId ?? '', {}, this.host.ui);
    standalone.updateResult({ content, isError: false });
    this.ensureToolGroup().addTool(standalone);
  }

  /**
   * 回放子代理开始事件：按 toolCallId 归位到 Task 工具行，聚合活动无法恢复
   * （子工具调用不落主会话），只恢复行首文案与 (type, background) 元信息；不建实时行。
   */
  attachReplayedSubagent(meta: {
    id: string;
    description: string;
    toolCallId?: string;
    childType?: string;
    background: boolean;
  }): boolean {
    const tool = meta.toolCallId !== undefined ? this.pendingTools.get(meta.toolCallId) : undefined;
    if (meta.id === '' || !tool) return false;
    tool.attachSubagentMeta({
      index: ++this.subagentOrdinal,
      childType: meta.childType,
      background: meta.background,
      description: meta.description,
    });
    this.subagentLines.set(meta.id, { tool, description: meta.description, toolCallId: meta.toolCallId, background: meta.background });
    return true;
  }
}
