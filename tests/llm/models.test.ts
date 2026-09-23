import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayNameForModel } from '../../src/plugins/sph-llm/models.js';

describe('displayNameForModel', () => {
  it('连字符版本号收成点号', () => {
    assert.equal(displayNameForModel('claude-opus-4-8'), 'Claude Opus 4.8');
    assert.equal(displayNameForModel('claude-fable-5-1'), 'Claude Fable 5.1');
  });

  it('已带点号的版本保持原样', () => {
    assert.equal(displayNameForModel('muse-spark-1.3-contributor-free'), 'Muse Spark 1.3 Contributor Free');
    assert.equal(displayNameForModel('gpt-5.4-mini'), 'GPT 5.4 Mini');
  });

  it('短缩写保持全大写', () => {
    assert.equal(displayNameForModel('glm-5.3-flash'), 'GLM 5.3 Flash');
    assert.equal(displayNameForModel('gpt-5-codex'), 'GPT 5 Codex');
  });
});
