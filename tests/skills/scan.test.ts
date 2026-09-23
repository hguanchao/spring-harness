import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scanSkills, skillRoots } from '../../src/plugins/sph-skills/scan.js';

function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`, 'utf8');
}

describe('skillRoots', () => {
  it('四个根按「用户级 → ~/.sph → 工作区 .agents → 工作区 .sph」排列', () => {
    // 顺序即优先级：/skills 直接把它显示给用户，错序会让用户照着一份错的清单放文件。
    assert.deepEqual(skillRoots('/ws', join('/home', '.sph'), '/home'), [
      join('/home', '.agents', 'skills'),
      join('/home', '.sph', 'skills'),
      join('/ws', '.agents', 'skills'),
      join('/ws', '.sph', 'skills'),
    ]);
  });
});

describe('scanSkills', () => {
  it('同名技能以靠后的根为准：工作区覆盖用户级', () => {
    const base = mkdtempSync(join(tmpdir(), 'sph-skills-'));
    const home = join(base, 'home');
    const ws = join(base, 'ws');
    try {
      writeSkill(join(home, '.agents', 'skills'), 'pdf', 'user level');
      writeSkill(join(ws, '.sph', 'skills'), 'pdf', 'workspace level');
      const { catalog } = scanSkills(ws, join(base, 'sph-home'), home);
      assert.equal(catalog.length, 1, '同名只保留一条');
      assert.equal(catalog[0]?.description, 'workspace level');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('缺 name/description frontmatter 的技能被跳过并留下警告', () => {
    const base = mkdtempSync(join(tmpdir(), 'sph-skills-nofm-'));
    const ws = join(base, 'ws');
    const root = join(ws, '.sph', 'skills');
    try {
      writeSkill(root, 'ok', 'fine');
      mkdirSync(join(root, 'broken'), { recursive: true });
      writeFileSync(join(root, 'broken', 'SKILL.md'), 'no frontmatter here\n', 'utf8');
      const { catalog, warnings } = scanSkills(ws, join(base, 'sph-home'), join(base, 'home'));
      assert.deepEqual(catalog.map((entry) => entry.name), ['ok']);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /broken/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('目录不存在时安静地返回空目录，不报警告', () => {
    const base = mkdtempSync(join(tmpdir(), 'sph-skills-empty-'));
    try {
      const { catalog, warnings } = scanSkills(base, join(base, 'nope'), join(base, 'nope2'));
      assert.deepEqual(catalog, []);
      assert.deepEqual(warnings, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('目录名与 frontmatter 里的 name 不一致时以 frontmatter 为准', () => {
    const base = mkdtempSync(join(tmpdir(), 'sph-skills-name-'));
    const ws = join(base, 'ws');
    try {
      const dir = join(ws, '.sph', 'skills', 'dir-name');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: real-name\ndescription: d\n---\n', 'utf8');
      const { catalog } = scanSkills(ws, join(base, 'sph-home'), join(base, 'home'));
      assert.deepEqual(catalog.map((entry) => entry.name), ['real-name']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
