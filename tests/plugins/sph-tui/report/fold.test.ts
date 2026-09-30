import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReportGroup } from '@/plugins/sph-tui/report/doc.js';
import { FoldState } from '@/plugins/sph-tui/report/fold.js';

function group(key: string, overrides: Partial<ReportGroup> = {}): ReportGroup {
  return { key, label: key, items: [], ...overrides };
}

describe('FoldState', () => {
  it('默认展开：改造前所有分组都是摊开的，默认值不该悄悄反过来', () => {
    assert.equal(new FoldState().isExpanded('skills', group('user')), true);
  });

  it('声明了 initiallyExpanded: false 的组默认收起', () => {
    assert.equal(new FoldState().isExpanded('plugins', group('failed', { initiallyExpanded: false })), false);
  });

  it('collapsible: false 的组永远展开，开合键对它无效', () => {
    const folds = new FoldState();
    folds.set('skills', 'warnings', false);
    assert.equal(folds.isExpanded('skills', group('warnings', { collapsible: false })), true);
  });

  it('toggle 之后按显式值走，默认值不再参与', () => {
    const folds = new FoldState();
    assert.equal(folds.toggle('skills', group('user')), false);
    assert.equal(folds.isExpanded('skills', group('user')), false);
    assert.equal(folds.toggle('skills', group('user')), true);
    assert.equal(folds.isExpanded('skills', group('user')), true);
  });

  it('默认收起的组 toggle 之后变成展开，不是叠一层默认值', () => {
    const folds = new FoldState();
    const failed = group('failed', { initiallyExpanded: false });
    assert.equal(folds.toggle('plugins', failed), true);
    assert.equal(folds.isExpanded('plugins', failed), true);
  });

  it('检索的强制展开只看不改：清空查询要回到用户自己摆的状态', () => {
    const folds = new FoldState();
    folds.set('skills', 'user', false);
    assert.equal(folds.isExpanded('skills', group('user'), true), true);
    assert.equal(folds.isExpanded('skills', group('user')), false, '强制展开不许写回状态');
  });

  it('按 tab 隔离：同名分组在两个 tab 里各自开合', () => {
    const folds = new FoldState();
    folds.set('skills', 'user', false);
    assert.equal(folds.isExpanded('skills', group('user')), false);
    assert.equal(folds.isExpanded('plugins', group('user')), true);
  });
});
