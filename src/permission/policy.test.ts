import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvalScopeKey, evaluateRules, HeadlessApprover, type PermissionRules } from './policy.js';

describe('approvalScopeKey', () => {
  it('shell 用命令原文：换一条命令就是另一个作用域', () => {
    const npm = approvalScopeKey({ tool: 'bash', command: 'npm test' });
    const rm = approvalScopeKey({ tool: 'bash', command: 'rm -rf /' });
    assert.equal(npm, 'bash npm test');
    assert.notEqual(
      npm,
      rm,
      '两条命令必须落在不同作用域——共用一个键就等于「总是允许」放行整个 shell',
    );
  });

  it('空白差异不产生新键', () => {
    assert.equal(
      approvalScopeKey({ tool: 'bash', command: '  npm   test\n' }),
      approvalScopeKey({ tool: 'bash', command: 'npm test' }),
    );
  });

  it('拿不到命令原文时退回工具名，而不是造一个更宽的键', () => {
    assert.equal(approvalScopeKey({ tool: 'bash' }), 'bash');
    assert.equal(approvalScopeKey({ tool: 'bash', command: '   ' }), 'bash');
  });

  it('escalate 按路径、mcp 按 server.tool', () => {
    assert.equal(approvalScopeKey({ tool: 'escalate', path: '/ws/out.txt' }), 'escalate /ws/out.txt');
    assert.equal(approvalScopeKey({ tool: 'mcp', command: 'fs.read_file' }), 'mcp fs.read_file');
    assert.equal(approvalScopeKey({ tool: 'mcp' }), 'mcp');
  });

  it('没有可再细分维度的工具按工具名记', () => {
    assert.equal(approvalScopeKey({ tool: 'enter_plan_mode' }), 'enter_plan_mode');
    // web_search 是只读网络查询，查询词每次都不同，按查询词记等于永远不命中。
    assert.equal(approvalScopeKey({ tool: 'web_search', command: 'a, b' }), 'web_search');
  });
});

const RULES: PermissionRules = {
  allow: ['bash:npm test'],
  ask: ['bash:git push*'],
  deny: ['bash:rm -rf*'],
};

describe('evaluateRules', () => {
  it('deny > ask > allow：三张表同时命中时取 deny', () => {
    const all = { allow: ['bash:*'], ask: ['bash:*'], deny: ['bash:rm -rf*'] };
    assert.equal(evaluateRules(all, { tool: 'bash', command: 'rm -rf /' }), 'deny');
  });

  it('ask > allow：两张表同时命中时取 ask', () => {
    const both = { allow: ['bash:*'], ask: ['bash:git push*'], deny: [] };
    assert.equal(evaluateRules(both, { tool: 'bash', command: 'git push origin main' }), 'ask');
  });

  it('通配匹配：* 任意长度、? 单字符', () => {
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'rm -rf build' }), 'deny');
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'git push' }), 'ask');
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test' }), 'allow');
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm run test' }), undefined);
    assert.equal(evaluateRules({ allow: [], ask: [], deny: ['bash:rm -rf?'] }, { tool: 'bash', command: 'rm -rfx' }), 'deny');
  });

  it('不带 pattern 的条目匹配该工具的全部动作', () => {
    assert.equal(
      evaluateRules({ allow: [], ask: [], deny: ['bash'] }, { tool: 'bash', command: 'anything at all' }),
      'deny',
    );
  });

  it('只按第一个冒号切分，命令里的冒号不会被切碎', () => {
    const rules = { allow: [], ask: [], deny: ['bash:git commit -m "fix: x"'] };
    assert.equal(evaluateRules(rules, { tool: 'bash', command: 'git commit -m "fix: x"' }), 'deny');
  });

  it('默认是精确匹配，不是前缀匹配', () => {
    assert.equal(
      evaluateRules({ allow: [], ask: [], deny: ['bash:rm -rf'] }, { tool: 'bash', command: 'rm -rf /tmp' }),
      undefined,
      '要前缀就写 rm -rf*——不加通配符不该悄悄放宽',
    );
  });

  it('工具名对不上则整条规则不生效', () => {
    assert.equal(evaluateRules(RULES, { tool: 'mcp', command: 'rm -rf' }), undefined);
  });

  it('没有规则时一律返回 undefined', () => {
    assert.equal(evaluateRules(undefined, { tool: 'bash', command: 'rm -rf /' }), undefined);
  });
});

describe('HeadlessApprover 与规则', () => {
  it('deny 规则连 yolo 也绕不过', async () => {
    const approver = new HeadlessApprover('yolo', undefined, { allow: [], ask: [], deny: ['bash:rm -rf*'] });
    assert.equal(await approver.decide({ tool: 'bash', command: 'rm -rf /' }), false);
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm test' }), true, 'yolo 下其余命令照常放行');
  });

  it('allow 规则让受审工具在 ask 模式下也放行', async () => {
    const approver = new HeadlessApprover('ask', undefined, { allow: ['bash:npm test'], ask: [], deny: [] });
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm test' }), true);
    assert.equal(await approver.decide({ tool: 'bash', command: 'npm run build' }), false, '其余仍按 ask 拒绝');
  });

  it('ask 规则在 headless 下等于拒绝：无人可问，不静默放行', async () => {
    const approver = new HeadlessApprover('yolo', undefined, { allow: [], ask: ['bash:git push*'], deny: [] });
    assert.equal(await approver.decide({ tool: 'bash', command: 'git push origin main' }), false);
  });
});
