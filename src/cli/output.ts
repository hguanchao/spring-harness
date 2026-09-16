/**
 * headless 的输出格式。
 *
 * - `text`（默认）：正文写 stdout，工具与进度写 stderr——给人看的。
 * - `json`：stdout 是逐行 JSON 事件（NDJSON），stderr 只留致命诊断——给脚本与 CI 用的。
 *
 * 两种格式并排放在一个模块里是有意的：它们必须覆盖同一批事件，分散在两处迟早会漂移成
 * 「TUI 看得见、脚本看不见」。
 *
 * JSON 事件直接沿用 `AgentEvent` 的形状，不做二次加工：再设计一层「给脚本用的中间格式」，
 * 那份格式终将与真实事件脱节，而事件本身就是稳定契约。收尾多一行 `type: "result"`，
 * 让常见脚本不必自己拼接增量：
 *
 *   sph -p "总结一下" --output-format json | jq -r 'select(.type=="result").text'
 */

import type { AgentListener } from '../agent/events.js';

export interface HeadlessOutput {
  listener: AgentListener;
  /** 轮次正常结束后的收尾行（含换行）；失败路径不发。 */
  finalLine(): string;
}

/** 人读格式：正文原样上屏，工具起止与状态走 stderr。 */
export function createTextOutput(): HeadlessOutput {
  const listener: AgentListener = (event) => {
    switch (event.type) {
      case 'text':
        process.stdout.write(event.text);
        break;
      case 'tool_start':
        process.stderr.write(`\n[${event.name}]\n`);
        break;
      case 'tool_end':
        process.stderr.write(`${event.content.slice(0, 400)}\n`);
        break;
      case 'subagent_start':
        // 子代理内部事件封在 subagent_event 里（default 丢弃）：headless 只报起止两行，
        // 详情留在子会话 JSONL，不往终端刷子代理的每一步。
        process.stderr.write(
          `\n[task] ${event.description} (${event.childType}${event.mode === 'background' ? ', background' : ''})\n`,
        );
        break;
      case 'subagent_end':
        process.stderr.write(
          `[task] ${event.ok ? 'done' : 'FAILED'} in ${(event.durationMs / 1000).toFixed(1)}s${event.ok ? '' : `: ${event.summary.slice(0, 200)}`}\n`,
        );
        break;
      case 'status':
      case 'error':
        process.stderr.write(`${event.text}\n`);
        break;
      default:
        break;
    }
  };
  return { listener, finalLine: () => '\n' };
}

export interface JsonOutputMeta {
  sessionId: string;
}

/** 机器读格式：每个事件一行 JSON，最后补一行汇总。 */
export function createJsonOutput(meta: JsonOutputMeta): HeadlessOutput {
  const text: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  const listener: AgentListener = (event) => {
    // 汇总所需的字段在途中累加：事后回读会话文件会多一次 I/O，且失败路径上未必可读。
    if (event.type === 'text') text.push(event.text);
    if (event.type === 'usage') {
      promptTokens += event.promptTokens;
      completionTokens += event.completionTokens;
      cachedTokens += event.cachedTokens ?? 0;
    }
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  return {
    listener,
    finalLine: () =>
      `${JSON.stringify({
        type: 'result',
        sessionId: meta.sessionId,
        text: text.join(''),
        usage: { promptTokens, completionTokens, cachedTokens },
      })}\n`,
  };
}
