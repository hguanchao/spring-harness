import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupCountSuffix, plainText, reportGroups, type ReportGroup } from '@/plugins/sph-tui/report/doc.js';
import { skillsTab } from '@/plugins/sph-tui/report/sources/skills.js';
import type { SkillEntry, SkillRoot } from '@/plugins/sph-skills/scan.js';

/** 测试里的技能根：`level` 决定组标题写 User 还是 Project。 */
function root(path: string, level: 'User' | 'Project' = 'User'): SkillRoot {
  return { path, level };
}

function skill(name: string, description: string, from = '/ws/skills'): SkillEntry {
  return { name, description, root: from, path: `${from}/${name}/SKILL.md` };
}

/** 组标题的纯文本，省得每个用例都自己拍平。 */
function heading(group: ReportGroup): string {
  return plainText(group.label);
}

function groupByKey(tab: ReturnType<typeof skillsTab>, key: string): ReportGroup | undefined {
  return reportGroups(tab.blocks).find((group) => group.key === key);
}

describe('skillsTab', () => {
  it('单一来源也画组标题：技能从哪来正是要确认的事', () => {
    const tab = skillsTab({
      catalog: [skill('pdf', 'Fill PDF forms', '/ws/.sph/skills'), skill('sheet', 'Edit spreadsheets', '/ws/.sph/skills')],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    const groups = reportGroups(tab.blocks);
    assert.equal(groups.length, 1);
    assert.equal(heading(groups[0]!), '#1  Project — /ws/.sph/skills');
    assert.equal(groups[0]!.countNoun, 'skills');
    assert.deepEqual(groups[0]!.items.map((item) => item.key), ['pdf', 'sheet']);
    assert.equal(plainText(groups[0]!.items[0]!.label), 'pdf');
    assert.equal(groups[0]!.items[0]!.description, 'Fill PDF forms');
  });

  it('多来源按覆盖次序倒着编号：#1 是会赢的那个', () => {
    // 根清单里 User 在前、Project 在后 → Project 覆盖 User，所以 Project 拿 #1。
    const tab = skillsTab({
      catalog: [skill('pdf', 'user copy', '/home/u/.sph/skills'), skill('pdf', 'project copy', '/ws/.sph/skills')],
      warnings: [],
      roots: [root('/home/u/.sph/skills', 'User'), root('/ws/.sph/skills', 'Project')],
    });
    const groups = reportGroups(tab.blocks);
    assert.equal(heading(groups[0]!), '#1  Project — /ws/.sph/skills');
    assert.equal(heading(groups[1]!), '#2  User — /home/u/.sph/skills');
  });

  it('空目录时说清技能长什么样、该放哪，而不是只说 0 个', () => {
    const tab = skillsTab({
      catalog: [],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    const prose = tab.blocks.find((block) => block.kind === 'prose');
    assert.ok(prose !== undefined, '空态是一段散文，不是空列表');
    assert.match(prose!.text, /SKILL.md/);
    const roots = groupByKey(tab, '__roots');
    assert.ok(roots !== undefined);
    assert.equal(roots!.collapsible, false);
    assert.equal(plainText(roots!.items[0]!.label), '1. Project — /ws/.sph/skills');
  });

  it('没货的根只占一句 caption，路径逐字保留', () => {
    const tab = skillsTab({
      catalog: [skill('pdf', 'd', '/ws/.sph/skills')],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project'), root('/other/empty', 'User')],
    });
    const captions = tab.blocks.filter((block) => block.kind === 'caption').map((block) => plainText(block.text));
    const missed = captions.find((text) => text.startsWith('nothing found in'));
    assert.equal(missed, 'nothing found in 1 other root: /other/empty');
  });

  it('描述里的换行被压成一行：一条技能只占一行', () => {
    const tab = skillsTab({
      catalog: [skill('pdf', 'Fill PDF forms\nand merge them', '/ws/.sph/skills')],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    assert.equal(reportGroups(tab.blocks)[0]!.items[0]!.description, 'Fill PDF forms and merge them');
  });

  it('描述里的反引号原样保留：报告不再过 markdown，也就没有转义这回事', () => {
    const tab = skillsTab({
      catalog: [skill('pdf', 'wrap `a` and `b`', '/ws/.sph/skills')],
      warnings: [],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    assert.equal(reportGroups(tab.blocks)[0]!.items[0]!.description, 'wrap `a` and `b`');
  });

  it('没有警告时不出现 Warnings 组', () => {
    const tab = skillsTab({ catalog: [], warnings: [], roots: [root('/ws/.sph/skills')] });
    assert.equal(groupByKey(tab, '__warnings'), undefined);
  });

  it('有警告时逐条列出，整组标警示色', () => {
    const tab = skillsTab({
      catalog: [skill('pdf', 'd', '/ws/.sph/skills')],
      warnings: ['bad frontmatter', 'missing name'],
      roots: [root('/ws/.sph/skills', 'Project')],
    });
    const warnings = groupByKey(tab, '__warnings');
    assert.ok(warnings !== undefined);
    assert.equal(warnings!.collapsible, false);
    assert.deepEqual(warnings!.items.map((item) => plainText(item.label)), ['bad frontmatter', 'missing name']);
    assert.equal(warnings!.items[0]!.tone, 'warning');
  });
});

describe('groupCountSuffix', () => {
  const group: ReportGroup = { key: 'k', label: 'User', countNoun: 'skills', items: [] };
  const silent: ReportGroup = { key: 'k', label: 'User', items: [] };

  it('没声明计量词就不渲染后缀', () => {
    assert.equal(groupCountSuffix(silent, 3, 3), null);
  });

  it('命中等于总数时只报一个数', () => {
    assert.equal(groupCountSuffix(group, 2, 2), '(2 skills)');
  });

  it('检索时报命中与总数：不假装搜索结果就是全部', () => {
    assert.equal(groupCountSuffix(group, 1, 5), '(1/5 skills)');
  });

  it('单数去掉词尾的 s', () => {
    assert.equal(groupCountSuffix(group, 1, 1), '(1 skill)');
  });
});

describe('plainText', () => {
  it('纯串原样返回', () => {
    assert.equal(plainText('pdf'), 'pdf');
  });

  it('分段按顺序拼接，语气不参与', () => {
    assert.equal(plainText([{ text: '1. ' }, { text: 'deny', tone: 'code' }]), '1. deny');
  });
});
