import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TUI } from '../../../src/plugins/sph-tui/screen/index.js';
import { Editor } from '../../../src/plugins/sph-tui/screen/editor.js';

const UNDO = '\x1f';
const BACKSPACE = '\x7f';

function editor(): Editor {
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: () => {},
  } as unknown as TUI;
  return new Editor(tui, {
    borderColor: (text) => text,
    selectList: {
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
      selectedMark: (mark) => mark,
      selectedRow: (text) => text,
    },
  });
}

function paste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

describe('Editor 输入', () => {
  it('退格按字素删，中文一次删掉', () => {
    const ed = editor();
    ed.handleInput('中');
    assert.equal(ed.getText(), '中');
    ed.handleInput(BACKSPACE);
    assert.equal(ed.getText(), '');
  });

  it('连续字母合成一次撤销，空格另起一段', () => {
    const ed = editor();
    ed.handleInput('h');
    ed.handleInput('i');
    ed.handleInput(UNDO);
    assert.equal(ed.getText(), '');

    ed.handleInput('a');
    ed.handleInput(' ');
    ed.handleInput('b');
    ed.handleInput(UNDO);
    assert.equal(ed.getText(), 'a');
  });

  it('括号粘贴整段插入，一次撤销回到粘贴前', () => {
    const ed = editor();
    ed.setText('x');
    ed.handleInput(paste('yz'));
    assert.equal(ed.getText(), 'xyz');
    ed.handleInput(UNDO);
    assert.equal(ed.getText(), 'x');
  });

  it('超长粘贴收成标记，展开后是原文，退格整段删掉', () => {
    const ed = editor();
    const body = 'a'.repeat(1001);
    ed.handleInput(paste(body));
    assert.match(ed.getText(), /^\[paste #1 1001 chars\]$/);
    assert.equal(ed.getExpandedText(), body);
    ed.handleInput(BACKSPACE);
    assert.equal(ed.getText(), '');
    assert.equal(ed.getExpandedText(), '');
  });
});
