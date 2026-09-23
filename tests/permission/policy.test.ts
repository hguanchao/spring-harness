import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvalScopeKey, evaluateRules, HeadlessApprover, type PermissionRules } from '../../src/permission/policy.js';

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

describe('evaluateRules 复合命令逐段求值', () => {
  const RULES: PermissionRules = {
    allow: ['bash:npm test', 'bash:git add*'],
    ask: [],
    deny: ['bash:rm -rf*'],
  };

  it('deny 命中任一子命令即命中：藏在 && 后面的 rm 逃不掉', () => {
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test && rm -rf build' }), 'deny');
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test | tee log; rm -rf /' }), 'deny');
  });

  it('allow 必须覆盖全部子命令，漏一段就落回模式', () => {
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test && git add .' }), 'allow');
    assert.equal(
      evaluateRules(RULES, { tool: 'bash', command: 'npm test && git push' }),
      undefined,
      'git push 没有 allow 规则，整条不能放行',
    );
  });

  it('子 shell 里的命令同样被 deny 看见、被 require 覆盖', () => {
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'echo $(rm -rf /)' }), 'deny');
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test && (git add -A)' }), 'allow');
  });

  it('引号内的分隔符不是切点', () => {
    assert.equal(
      evaluateRules(RULES, { tool: 'bash', command: 'git add -m "a && b" ; npm test' }),
      'allow',
    );
    assert.equal(
      evaluateRules({ allow: ['bash:echo "a && b"'], ask: [], deny: [] }, { tool: 'bash', command: 'echo "a && b"' }),
      'allow',
    );
  });

  it('2>&1 的 & 是文件描述符复制，不是分隔符', () => {
    const rules: PermissionRules = { allow: ['bash:npm test*'], ask: [], deny: [] };
    // 若把 & 当分隔符，会拆出裸的 '1' 段、无规则可覆盖；不切则整段命中前缀规则。
    assert.equal(evaluateRules(rules, { tool: 'bash', command: 'npm test 2>&1' }), 'allow');
  });

  it('解析不了的命令不允许被 allow 放行，deny 仍按原文兜底', () => {
    // 截断的操作符
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test &&' }), undefined);
    // 未闭合引号
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: "npm test && echo 'oops" }), undefined);
    // 连续分隔符
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test ;; git add .' }), undefined);
    // 未闭合子 shell
    assert.equal(evaluateRules(RULES, { tool: 'bash', command: 'npm test && (git add' }), undefined);
    // deny 按原文匹配仍能拦
    assert.equal(
      evaluateRules({ allow: [], ask: [], deny: ['bash:npm test*'] }, { tool: 'bash', command: 'npm test &&' }),
      'deny',
    );
  });

  it('引号内的命令替换和 bash 反引号拆不开，allow 不放行', () => {
    const rules: PermissionRules = {
      allow: ['bash:echo*', 'bash:npm test'],
      ask: [],
      deny: ['bash:rm -rf*'],
    };
    assert.equal(evaluateRules(rules, { tool: 'bash', command: 'echo "$(rm -rf /)"' }), undefined);
    assert.equal(evaluateRules(rules, { tool: 'bash', command: 'echo `rm -rf /`' }), undefined);
    assert.equal(
      evaluateRules(rules, { tool: 'bash', command: 'npm test && echo "$(rm -rf /)"' }),
      undefined,
      '前一段命中 allow 也不能把藏在后一段引号里的替换一起放行',
    );
    // 单引号不展开。双引号里被反斜杠转义的 $( 也不执行，括号又不是切点。
    assert.equal(evaluateRules(rules, { tool: 'bash', command: "echo '$(rm -rf /)'" }), 'allow');
    assert.equal(evaluateRules(rules, { tool: 'bash', command: 'echo "\\$(rm -rf /)"' }), 'allow');
    // 未加引号的 $(...) 仍被括号切开，deny 看得见。
    assert.equal(evaluateRules(rules, { tool: 'bash', command: 'echo $(rm -rf /)' }), 'deny');
  });

  it('pwsh 的双引号子表达式挡住 allow，反引号是转义不是替换', () => {
    const rules: PermissionRules = { allow: ['pwsh:Write-Output*'], ask: [], deny: [] };
    assert.equal(
      evaluateRules(rules, { tool: 'pwsh', command: 'Write-Output "$(Remove-Item x)"' }),
      undefined,
    );
    assert.equal(evaluateRules(rules, { tool: 'pwsh', command: "Write-Output '$(Remove-Item x)'" }), 'allow');
    assert.equal(evaluateRules(rules, { tool: 'pwsh', command: 'Write-Output `n' }), 'allow');
  });

  it('非 shell 工具（mcp/web_search）不按 shell 语义拆分', () => {
    assert.equal(
      evaluateRules({ allow: ['web_search:weather*'], ask: [], deny: [] }, { tool: 'web_search', command: 'weather | tokyo' }),
      'allow',
      '查询文本里的 | 是内容不是管道',
    );
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
