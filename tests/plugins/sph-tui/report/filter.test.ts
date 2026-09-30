import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainText, reportGroups, type ReportTab } from '@/plugins/sph-tui/report/doc.js';
import { filterTab } from '@/plugins/sph-tui/report/filter.js';
import { skillsTab } from '@/plugins/sph-tui/report/sources/skills.js';
import type { SkillEntry, SkillRoot } from '@/plugins/sph-skills/scan.js';

function root(path: string, level: 'User' | 'Project' = 'User'): SkillRoot {
  return { path, level };
}

function skill(name: string, description: string, from = '/ws/.sph/skills'): SkillEntry {
  return { name, description, root: from, path: `${from}/${name}/SKILL.md` };
}

/**
 * 两组三技能。`aaa` 是故意加在末尾的——它的字典序在最前，用来验证「空查询不重排」。
 */
function twoRoots(): ReportTab {
  return skillsTab({
    catalog: [
      skill('pdf', 'Fill PDF forms', '/ws/.sph/skills'),
      skill('sheet', 'Edit spreadsheets', '/ws/.sph/skills'),
      skill('aaa', 'Zzz last in scan order', '/ws/.sph/skills'),
      skill('notes', 'Take meeting notes', '/home/u/.sph/skills'),
    ],
    warnings: [],
    roots: [root('/home/u/.sph/skills', 'User'), root('/ws/.sph/skills', 'Project')],
  });
}

describe('filterTab', () => {
  it('空查询原样返回：业务算出来的优先级不许被模糊分覆盖', () => {
    const tab = twoRoots();
    const filtered = filterTab(tab, '   ');
    assert.equal(filtered.filtering, false);
    assert.equal(filtered.blocks, tab.blocks, '空查询直接交回原块列表，一个字都不动');
    const groups = reportGroups(filtered.blocks);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0]!.items.map((item) => item.key), ['pdf', 'sheet', 'aaa'], '组内保持扫描顺序，不按字典序');
  });

  it('命中只留相关组，零命中的组整组消失', () => {
    const filtered = filterTab(twoRoots(), 'sheet');
    assert.equal(filtered.filtering, true);
    const groups = filtered.blocks.filter((block) => block.kind === 'group');
    assert.equal(groups.length, 1);
    assert.equal(plainText(groups[0]!.group.label), '#1  Project — /ws/.sph/skills');
    assert.deepEqual(groups[0]!.group.items.map((item) => item.key), ['sheet']);
  });

  it('计数报命中与总数', () => {
    const filtered = filterTab(twoRoots(), 'spread');
    assert.deepEqual(filtered.counts.get('/ws/.sph/skills'), { hit: 1, total: 3 });
    assert.deepEqual(filtered.counts.get('/home/u/.sph/skills'), { hit: 0, total: 1 });
  });

  it('描述也在检索范围内，不只按名字搜', () => {
    const filtered = filterTab(twoRoots(), 'meeting');
    const groups = filtered.blocks.filter((block) => block.kind === 'group');
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.group.items.map((item) => item.key), ['notes']);
  });

  it('组标题里带着来源路径，按路径找也成立', () => {
    const filtered = filterTab(twoRoots(), '/home/u');
    const groups = filtered.blocks.filter((block) => block.kind === 'group');
    assert.equal(groups.length, 1);
    assert.equal(plainText(groups[0]!.group.label), '#2  User — /home/u/.sph/skills');
  });

  it('一句话说明与散文在检索时退场：它们不是可选内容', () => {
    const tab: ReportTab = {
      id: 't',
      label: 'T',
      empty: 'none',
      blocks: [
        { kind: 'caption', text: 'read once, not every time' },
        { kind: 'prose', text: 'a paragraph of prose' },
        { kind: 'code', text: 'x = 1' },
        { kind: 'group', group: { key: 'g', label: 'G', items: [{ key: 'hit', label: 'hit me' }] } },
      ],
    };
    const filtered = filterTab(tab, 'hit');
    assert.deepEqual(filtered.blocks.map((block) => block.kind), ['group']);
  });

  it('一条都没命中时 hits 为 0，交给渲染层出空态', () => {
    const filtered = filterTab(twoRoots(), 'zzzz');
    assert.equal(filtered.hits, 0);
    assert.equal(filtered.filtering, true);
    assert.deepEqual(filtered.blocks, []);
  });

  it('多词查询按空格拆开，每个词都要命中', () => {
    const filtered = filterTab(twoRoots(), 'pdf forms');
    const groups = filtered.blocks.filter((block) => block.kind === 'group');
    assert.deepEqual(groups[0]!.group.items.map((item) => item.key), ['pdf']);
  });
});
