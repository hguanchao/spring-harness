import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayNameForModel, modelIdsFromCatalog } from '../../src/plugins/sph-llm/models.js';

describe('displayNameForModel', () => {
  it('连字符版本号收成点号', () => {
    assert.equal(displayNameForModel('claude-opus-4-8'), 'Claude Opus 4.8');
    assert.equal(displayNameForModel('claude-fable-5-1'), 'Claude Fable 5.1');
  });

  it('已带点号的版本保持原样', () => {
    assert.equal(displayNameForModel('muse-spark-1.3-contributor-free'), 'Muse Spark 1.3 Contributor Free');
    assert.equal(displayNameForModel('gpt-5.4-mini'), 'GPT 5.4 Mini');
  });

  it('OpenAI data.id、Gemini models.name、字符串列表都能取出 id', () => {
    assert.deepEqual(
      modelIdsFromCatalog({ data: [{ id: 'gpt-4o' }, { id: 'o3' }] }),
      ['gpt-4o', 'o3'],
    );
    assert.deepEqual(
      modelIdsFromCatalog({ models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] }),
      ['gemini-2.5-flash', 'gemini-2.5-pro'],
    );
    assert.deepEqual(modelIdsFromCatalog(['deepseek-chat', 'deepseek-reasoner']), ['deepseek-chat', 'deepseek-reasoner']);
  });

  it('短缩写保持全大写', () => {
    assert.equal(displayNameForModel('glm-5.3-flash'), 'GLM 5.3 Flash');
    assert.equal(displayNameForModel('gpt-5-codex'), 'GPT 5 Codex');
  });
});
