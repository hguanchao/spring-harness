import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { skillTool } from '../../src/tools/skill.js';
import { EMPTY_PLUGIN_SERVICES } from '../../src/plugins/types.js';
import type { ToolContext } from '../../src/tools/types.js';

function ctx(skills: ToolContext['skills']): ToolContext {
  return {
    workspaceRoot: tmpdir(),
    sandboxMode: 'off',
    skills,
    todos: {} as ToolContext['todos'],
    jobs: {} as ToolContext['jobs'],
    services: EMPTY_PLUGIN_SERVICES,
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    approve: async () => true,
    askUser: async () => '',
    noteMemoryTouch() {},
    spawnSubagent: async () => '',
    sendToSubagent: () => 'not_found',
  };
}

describe('skillTool', () => {
  it('returns the SKILL.md body and lists sibling attachment files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-skill-'));
    try {
      const dir = join(root, 'pdf-guide');
      mkdirSync(dir);
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: pdf-guide\ndescription: build pdfs\n---\n\n# PDF guide\nsee refs/api.md');
      writeFileSync(join(dir, 'refs.md'), 'api reference body');
      writeFileSync(join(dir, 'notes.txt'), 'plain notes');
      const result = await skillTool.execute({ name: 'pdf-guide' }, ctx([
        { name: 'pdf-guide', description: 'build pdfs', path: join(dir, 'SKILL.md') },
      ]));
      assert.equal(result.ok, true);
      assert.ok(result.content.includes('# PDF guide'));
      assert.ok(result.content.includes('Attached files'));
      assert.ok(result.content.includes('- refs.md'));
      assert.ok(result.content.includes('- notes.txt'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits the attachment section for a single-file skill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-skill-'));
    try {
      const dir = join(root, 'solo');
      mkdirSync(dir);
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: solo\ndescription: one file\n---\n\n# solo');
      const result = await skillTool.execute({ name: 'solo' }, ctx([
        { name: 'solo', description: 'one file', path: join(dir, 'SKILL.md') },
      ]));
      assert.equal(result.ok, true);
      assert.ok(!result.content.includes('Attached files'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat subdirectories or SKILL.md itself as attachments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-skill-'));
    try {
      const dir = join(root, 'nested');
      mkdirSync(dir);
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: nested\ndescription: has subdir\n---\n\n# nested');
      writeFileSync(join(dir, 'scripts', 'run.py'), 'print(1)');
      const result = await skillTool.execute({ name: 'nested' }, ctx([
        { name: 'nested', description: 'has subdir', path: join(dir, 'SKILL.md') },
      ]));
      assert.equal(result.ok, true);
      assert.ok(!result.content.includes('scripts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
