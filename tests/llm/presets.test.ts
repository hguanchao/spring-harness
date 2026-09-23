import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferEndpointPreset, mergePresetHeaders } from '../../src/plugins/sph-llm/presets.js';

describe('endpoint presets', () => {
  it('maps known hosts to a protocol', () => {
    assert.equal(inferEndpointPreset('https://api.anthropic.com')?.api, 'anthropic-messages');
    assert.equal(inferEndpointPreset('https://openrouter.ai/api/v1')?.api, 'chat-completions');
    assert.equal(inferEndpointPreset('https://api.deepseek.com/v1')?.api, 'chat-completions');
    assert.equal(inferEndpointPreset('https://159.75.184.92/sub2api/v1'), undefined);
  });

  it('user headers win over preset headers', () => {
    const merged = mergePresetHeaders('https://openrouter.ai/api/v1', { 'X-Title': 'mine' });
    assert.equal(merged['X-Title'], 'mine');
    assert.ok(merged['HTTP-Referer']);
  });
});

