import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripTerminalSequences } from '../../../src/tui/index.js';
import { FooterComponent, type FooterData } from '../../../src/plugins/sph-tui/components/footer.js';

function render(data: FooterData, width: number): string {
  const footer = new FooterComponent({ get: () => data });
  return stripTerminalSequences(footer.render(width)[0] ?? '');
}

const full: FooterData = {
  cwd: 'E:/Projects/restful-helper',
  gitBranch: 'main',
  agent: 'explore',
  approval: 'yolo',
  model: 'deepseek-v4.1-flash',
  effort: 'high',
  contextWindow: 1_000_000,
  contextTokens: 25_000,
};

describe('底栏', () => {
  it('四段都在，缓存百分比和花费不出现', () => {
    const line = render(full, 200);
    assert.match(line, /📁 restful-helper/);
    assert.match(line, /🌿 main/);
    assert.match(line, /🧩 explore/);
    assert.match(line, /🛡️ yolo/);
    assert.match(line, /🤖 deepseek-v4.1-flash/);
    assert.match(line, /🧠 high/);
    assert.match(line, /🧮 25k \/ 1\.0M/);
    assert.equal(line.includes('%'), false);
    assert.equal(line.includes('$'), false);
  });

  it('变窄时先丢掉项目和模型，审批和水位留着', () => {
    const line = render(full, 40);
    assert.equal(line.includes('restful-helper'), false);
    assert.equal(line.includes('deepseek'), false);
    assert.match(line, /yolo/);
    assert.match(line, /25k \/ 1\.0M/);
  });
});
