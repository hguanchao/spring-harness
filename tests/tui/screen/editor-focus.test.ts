import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../../../src/tui/index.js';
import { stripTerminalSequences } from '../../../src/tui/index.js';
import { Editor } from '../../../src/tui/editor.js';

const IDLE = '\x1b[90m';
const FOCUS = '\x1b[95m';
const RESET = '\x1b[39m';
const INVERSE = '\x1b[7m';

function makeEditor(): Editor {
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: () => {},
  } as unknown as TUI;
  const editor = new Editor(tui, {
    borderColor: (text) => `${IDLE}${text}${RESET}`,
    focusBorderColor: (text) => `${FOCUS}${text}${RESET}`,
    selectList: {
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
      selectedMark: (mark) => mark,
      selectedRow: (text) => text,
    },
  });
  editor.setText('hello');
  return editor;
}

describe('Editor 聚焦 / 失焦', () => {
  it('聚焦用 focus 边框色，失焦回弱化边框', () => {
    const editor = makeEditor();
    const blurred = editor.render(20);
    assert.ok(blurred[0]?.includes(IDLE), '失焦顶边应是弱化色');
    assert.equal(blurred[0]?.includes(FOCUS), false);

    editor.focused = true;
    const focused = editor.render(20);
    assert.ok(focused[0]?.includes(FOCUS), '聚焦顶边应是强调色');
    assert.equal(focused[0]?.includes(IDLE), false);
    assert.equal(stripTerminalSequences(focused[0] ?? ''), stripTerminalSequences(blurred[0] ?? ''));
  });

  it('计划模式聚焦与失焦用同一边框色', () => {
    const PLAN = '\x1b[94m';
    const tui = {
      terminal: { rows: 24, columns: 80 },
      requestRender: () => {},
    } as unknown as TUI;
    const editor = new Editor(tui, {
      borderColor: (text) => `${PLAN}${text}${RESET}`,
      focusBorderColor: (text) => `${PLAN}${text}${RESET}`,
      selectList: {
        description: (text) => text,
        scrollInfo: (text) => text,
        noMatch: (text) => text,
        selectedMark: (mark) => mark,
        selectedRow: (text) => text,
      },
    });
    editor.setText('hello');
    const blurred = editor.render(20)[0] ?? '';
    editor.focused = true;
    const focused = editor.render(20)[0] ?? '';
    assert.ok(blurred.includes(PLAN));
    assert.ok(focused.includes(PLAN));
    assert.equal(stripTerminalSequences(focused), stripTerminalSequences(blurred));
  });

  it('失焦不画假光标，聚焦才反色', () => {
    const editor = makeEditor();
    const blurred = editor.render(20).join('\n');
    assert.equal(blurred.includes(INVERSE), false, '失焦不应留下反色光标');

    editor.focused = true;
    const focused = editor.render(20).join('\n');
    assert.ok(focused.includes(INVERSE), '聚焦应画假光标');
  });

  it('焦点变化会立刻 requestRender', () => {
    const tui = {
      terminal: { rows: 24, columns: 80 },
      paints: 0,
      requestRender() {
        this.paints += 1;
      },
    };
    const editor = new Editor(tui as unknown as TUI, {
      borderColor: (text) => text,
      focusBorderColor: (text) => text,
      selectList: {
        description: (text) => text,
        scrollInfo: (text) => text,
        noMatch: (text) => text,
        selectedMark: (mark) => mark,
        selectedRow: (text) => text,
      },
    });
    editor.focused = true;
    editor.focused = true;
    editor.focused = false;
    assert.equal(tui.paints, 2, '同值赋值不该重复重绘');
  });
});
