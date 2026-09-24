/**
 * 回合事件投影成转录里的一行。
 *
 * 界面重写之前，先把「事件变成什么字」从控件里拆出来。
 * 绘制只负责把这些行画上去，不再自己解释协议。
 */
import type { AgentEvent } from '../../agent/events.js';
import { toolDisplayName } from './components/tool-execution.js';

export interface TranscriptLine {
  kind: 'user' | 'assistant' | 'tool' | 'subagent' | 'status';
  text: string;
}

const ONE_LINE = 160;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ONE_LINE ? `${flat.slice(0, ONE_LINE - 1)}…` : flat;
}

/** 一条事件对应的转录行。不进转录的事件返回 undefined。 */
export function projectEvent(event: AgentEvent): TranscriptLine | undefined {
  switch (event.type) {
    case 'text':
      return event.text.trim() === '' ? undefined : { kind: 'assistant', text: event.text };
    case 'tool_end': {
      const name = toolDisplayName(event.name);
      const mark = event.ok ? name : `${name} failed`;
      const detail = oneLine(event.content);
      return { kind: 'tool', text: detail === '' ? mark : `${mark}: ${detail}` };
    }
    case 'subagent_end': {
      const mark = event.ok ? 'Task' : 'Task failed';
      const detail = oneLine(event.summary);
      return { kind: 'subagent', text: detail === '' ? mark : `${mark}: ${detail}` };
    }
    case 'status':
      return { kind: 'status', text: oneLine(event.text) };
    default:
      return undefined;
  }
}
