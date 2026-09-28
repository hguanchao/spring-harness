import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { beginTranscriptClick, finishTranscriptClick, selectTranscriptRow } from '../../../src/plugins/sph-tui/components/row-selection.js';

describe('点在别处取消工具行选中', () => {
  function tracker(): { selected: boolean; release: () => boolean } {
    const state = { selected: false, release: (): boolean => false };
    state.release = () => {
      if (!state.selected) return false;
      state.selected = false;
      return true;
    };
    return state;
  }

  it('点在行上保留选中', () => {
    const row = tracker();
    beginTranscriptClick();
    selectTranscriptRow(row.release);
    row.selected = true;
    assert.equal(finishTranscriptClick(), false);
    assert.equal(row.selected, true);
  });

  it('点在别处清掉选中', () => {
    const row = tracker();
    beginTranscriptClick();
    selectTranscriptRow(row.release);
    row.selected = true;
    finishTranscriptClick();

    beginTranscriptClick();
    assert.equal(finishTranscriptClick(), true);
    assert.equal(row.selected, false);
  });

  it('再点同一行不会先清掉再丢掉', () => {
    const row = tracker();
    beginTranscriptClick();
    selectTranscriptRow(row.release);
    row.selected = true;
    finishTranscriptClick();

    beginTranscriptClick();
    selectTranscriptRow(row.release);
    assert.equal(finishTranscriptClick(), false);
    assert.equal(row.selected, true);
  });
});
