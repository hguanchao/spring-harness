import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAgents, parseAgentFile } from '../../src/plugins/sph-subagent/agents.js';
import setup from '../../src/plugins/sph-subagent/index.js';
import { createSubagentTool } from '../../src/plugins/sph-subagent/tool.js';
import { SUBAGENT_SERVICE, type SubagentCatalog } from '../../src/plugins/services.js';
import { EMPTY_PLUGIN_SERVICES, type PluginApi, type PluginHostFacts } from '../../src/plugins/types.js';
import type { ToolContext, ToolSpec } from '../../src/tools/types.js';

const SCOUT = `---
name: scout
description: Looks around
tools: read, grep
writes: false
---

Look, do not touch.
`;

describe('agent 文件', () => {
  it('解析 frontmatter 与正文；缺字段的文件丢掉', () => {
    const scout = parseAgentFile(SCOUT);
    assert.equal(scout?.name, 'scout');
    assert.deepEqual(scout?.tools, ['read', 'grep']);
    assert.equal(scout?.writes, false);
    assert.match(scout?.systemPrompt ?? '', /Look, do not touch/);
    assert.equal(parseAgentFile('no frontmatter'), undefined);
    assert.equal(parseAgentFile('---\ntools: read\n---\n\nbody\n'), undefined);
  });

  it('内置 explore 只读，general 会写；项目级同名整份替换，未信任时不读', () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-agents-'));
    try {
      const none = join(root, 'no-user-agents');
      const trusted = discoverAgents(root, true, none);
      assert.equal(trusted.find((agent) => agent.name === 'explore')?.writes, false);
      assert.equal(trusted.find((agent) => agent.name === 'general')?.writes, true);

      const dir = join(root, '.sph', 'agents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'explore.md'), SCOUT.replace('name: scout', 'name: explore'), 'utf8');
      const replaced = discoverAgents(root, true, none).find((agent) => agent.name === 'explore');
      assert.deepEqual(replaced?.tools, ['read', 'grep']);
      const builtinExplore = discoverAgents(root, false, none).find((agent) => agent.name === 'explore');
      assert.equal(builtinExplore?.tools.includes('glob'), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('subagent 工具', () => {
  function ctx(spawned: Array<{ agent: string; isolation?: string }>): ToolContext {
    return {
      workspaceRoot: process.cwd(),
      sandboxMode: 'off',
      skills: [],
      todos: {} as ToolContext['todos'],
      jobs: {} as ToolContext['jobs'],
      services: EMPTY_PLUGIN_SERVICES,
      runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      approve: async () => true,
      askUser: async () => '',
      noteMemoryTouch() {},
      spawnSubagent: async (input) => {
        spawned.push({ agent: input.agent, isolation: input.isolation });
        return 'done';
      },
      sendToSubagent: () => 'not_found',
    };
  }

  const tool = createSubagentTool(() => discoverAgents(process.cwd(), false));

  it('未知 agent 拒绝，不派生', async () => {
    const spawned: Array<{ agent: string }> = [];
    const result = await tool.execute({ prompt: 'p', description: 'd', agent: 'nope' }, ctx(spawned));
    assert.equal(result.ok, false);
    assert.match(result.content, /unknown agent "nope"/);
    assert.equal(spawned.length, 0);
  });

  it('省略 agent 用 general；explore 与 worktree 照传', async () => {
    const spawned: Array<{ agent: string; isolation?: string }> = [];
    const c = ctx(spawned);
    assert.equal((await tool.execute({ prompt: 'p', description: 'd' }, c)).ok, true);
    assert.equal((await tool.execute({ prompt: 'p', description: 'd', agent: 'explore' }, c)).ok, true);
    assert.equal(
      (await tool.execute({ prompt: 'p', description: 'd', agent: 'general', isolation: 'worktree' }, c)).ok,
      true,
    );
    assert.deepEqual(spawned, [
      { agent: 'general', isolation: 'none' },
      { agent: 'explore', isolation: 'none' },
      { agent: 'general', isolation: 'worktree' },
    ]);
  });

  it('isolation 拼错时拒绝', async () => {
    const spawned: Array<{ agent: string }> = [];
    const result = await tool.execute({ prompt: 'p', description: 'd', isolation: 'Worktree' }, ctx(spawned));
    assert.equal(result.ok, false);
    assert.match(result.content, /isolation must be "none" or "worktree"/);
  });
});

describe('sph-subagent 装载', () => {
  it('注册两个工具并提供目录服务', () => {
    const tools: ToolSpec[] = [];
    const services = new Map<string, unknown>();
    const host: PluginHostFacts = {
      sphHome: process.cwd(),
      mergeChildEnv: (extra) => ({ ...(extra ?? {}) }),
      canonicalize: (p) => p,
      isWorkspaceTrusted: () => false,
    };
    const api: PluginApi = {
      name: 'sph-subagent',
      workspaceRoot: process.cwd(),
      configPath: 'config.toml',
      host,
      registerTool: (tool) => tools.push(tool),
      provide: (name, service) => services.set(name, service),
      consume: () => undefined,
      warn: () => {},
      clip: (text) => text,
      onDispose: () => {},
    };
    setup(api);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['send_subagent_message', 'subagent']);
    assert.equal(tools.find((tool) => tool.name === 'send_subagent_message')?.rootOnly, true);
    const catalog = services.get(SUBAGENT_SERVICE) as SubagentCatalog;
    assert.equal(catalog.find('explore')?.writes, false);
    assert.equal(catalog.find('general')?.writes, true);
    assert.equal(catalog.find('missing'), undefined);
  });
});
