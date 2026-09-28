import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvalScopeKey,
  evaluateRules,
  HeadlessApprover,
  isReadOnlyCommand,
  matchCommandPattern,
  parseRuleEntry,
  splitShellCommands,
  stripCommandWrappers,
  suggestAllowRule,
  visibleTools,
  type RuleLayers,
} from '../../src/permission/policy.js';

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

  it('取不到细节时退回工具名，而不是造一个更宽的键', () => {
    assert.equal(approvalScopeKey({ tool: 'web_search' }), 'web_search');
    assert.equal(approvalScopeKey({ tool: 'mcp' }), 'mcp');
  });
});

/** 用户级规则（来源目录固定为 /home/u/.sph，供 `/path` 锚定）。 */
function user(rules: Partial<Record<'allow' | 'ask' | 'deny', string[]>>): RuleLayers {
  return {
    user: {
      rules: { allow: rules.allow ?? [], ask: rules.ask ?? [], deny: rules.deny ?? [] },
      sourceDir: '/home/u/.sph',
    },
  };
}

const ENV = { workspaceRoot: '/ws', home: '/home/u' };

function shell(command: string, layers: RuleLayers): string | undefined {
  return evaluateRules(layers, { tool: 'bash', command }, ENV);
}

describe('规则语法', () => {
  it('旧写法 tool:pattern 直接报错，并给出新写法', () => {
    assert.throws(() => parseRuleEntry('bash:npm *', 'allow', 'user', 'permissions.allow'), /removed "tool:pattern" syntax/);
    assert.throws(() => parseRuleEntry('bash:npm *', 'allow', 'user', 'permissions.allow'), /bash\(/);
  });

  it('工具名位置的通配只在 deny / ask 里可以写；allow 必须写字面工具名', () => {
    assert.equal(parseRuleEntry('mcp*', 'deny', 'user', 'permissions.deny').toolGlob !== undefined, true);
    assert.throws(() => parseRuleEntry('mcp*', 'allow', 'user', 'permissions.allow'), /allow rules must name a tool literally/);
  });

  it('否定只对路径规则成立', () => {
    assert.equal(parseRuleEntry('read(!sample.env)', 'deny', 'user', 'permissions.deny').negated, true);
    assert.throws(() => parseRuleEntry('bash(!npm *)', 'deny', 'user', 'permissions.deny'), /negation only applies to path rules/);
  });
});

describe('shell 命令匹配', () => {
  it('前缀通配：`*` 含空格，末尾 ` *` 也匹配裸命令', () => {
    assert.equal(matchCommandPattern('npm run *', 'npm run build'), true);
    assert.equal(matchCommandPattern('npm run *', 'npm run'), true, '末尾 * 也匹配裸命令');
    assert.equal(matchCommandPattern('npm run *', 'npm install'), false);
    assert.equal(matchCommandPattern('ls *', 'ls -la'), true);
    assert.equal(matchCommandPattern('ls *', 'lsof'), false, '空格是规则的一部分');
    assert.equal(matchCommandPattern('git log * main', 'git log --oneline main'), true);
    assert.equal(matchCommandPattern('git log * main', 'git log main'), false);
  });

  it('`:*` 与 ` *` 等价；冒号不在末尾时是字面字符', () => {
    assert.equal(matchCommandPattern('npm test:*', 'npm test --watch'), true);
    assert.equal(matchCommandPattern('git: push', 'git: push'), true);
  });

  it('剥离包装器：timeout / nice / env 前缀都算同一个命令', () => {
    assert.equal(stripCommandWrappers('timeout 30 npm test'), 'npm test');
    assert.equal(stripCommandWrappers('NODE_ENV=test npm test'), 'npm test');
    assert.equal(stripCommandWrappers('nohup nice -n 5 node s.js'), 'node s.js');
    const layers = user({ allow: ['bash(npm test *)'] });
    assert.equal(shell('timeout 30 npm test', layers), 'allow');
    assert.equal(shell('NODE_ENV=test npm test --watch', layers), 'allow');
  });

  it('包装器剥离对 deny 只更严：`timeout 30 rm -rf /` 照样被 rm 规则抓住', () => {
    assert.equal(shell('timeout 30 rm -rf /tmp/x', user({ deny: ['bash(rm *)'] })), 'deny');
  });

  it('不剥 npx —— 它真的换了程序', () => {
    assert.equal(stripCommandWrappers('npx cowsay hi'), 'npx cowsay hi');
    assert.equal(shell('npx cowsay hi', user({ allow: ['bash(cowsay *)'] })), undefined);
  });

  it('复合命令逐段：deny 命中任一段即命中，allow 必须覆盖每一段', () => {
    assert.equal(shell('npm test && rm -rf /', user({ deny: ['bash(rm *)'] })), 'deny');
    const partial = user({ allow: ['bash(npm test *)'] });
    assert.equal(shell('npm test && curl https://x', partial), undefined, '有一段没罩住就不算通过');
    const full = user({ allow: ['bash(npm test *)', 'bash(curl *)'] });
    assert.equal(shell('npm test && curl https://x', full), 'allow');
  });

  it('解析不了的命令不给 allow（fail-closed）', () => {
    assert.equal(splitShellCommands('npm test &&'), undefined);
    assert.equal(shell('npm test &&', user({ allow: ['bash(npm *)'] })), undefined);
  });

  it('段内有打不开的命令替换时不给 allow', () => {
    assert.equal(shell('echo "$(rm -rf /)"', user({ allow: ['bash(echo *)'] })), undefined);
  });

  it('参数匹配：只认列出来的参数名，其余按命令前缀解释', () => {
    const layers = user({ allow: ['bash(background=true)'] });
    assert.equal(evaluateRules(layers, { tool: 'bash', command: 'npm run dev', args: { background: true } }, ENV), 'allow');
    assert.equal(evaluateRules(layers, { tool: 'bash', command: 'npm run dev', args: { background: false } }, ENV), undefined);
    assert.equal(shell('background=true', layers), undefined, '没传 args 时该规则不命中');
  });
});

describe('路径规则', () => {
  const target = (path: string, realPath?: string) => ({ tool: 'read', path, ...(realPath === undefined ? {} : { realPath }) });

  it('四种锚定：`//` 绝对、`~/` 主目录、`/` 相对配置来源、裸路径相对工作区', () => {
    assert.equal(evaluateRules(user({ deny: ['read(//etc/**)'] }), target('/etc/passwd'), ENV), 'deny');
    assert.equal(
      evaluateRules(user({ deny: ['read(//C:/secret/**)'] }), target('C:/secret/a.txt'), { workspaceRoot: 'C:/ws', home: 'C:/Users/u' }),
      'deny',
      'Windows 盘符绝对路径去掉 // 标记后仍要能对上',
    );
    assert.equal(evaluateRules(user({ deny: ['read(~/.ssh/**)'] }), target('/home/u/.ssh/id_rsa'), ENV), 'deny');
    assert.equal(evaluateRules(user({ deny: ['read(/secrets/**)'] }), target('/home/u/.sph/secrets/x'), ENV), 'deny', '/ 锚定到配置来源目录');
    assert.equal(evaluateRules(user({ deny: ['read(*.env)'] }), target('config/.env'), ENV), 'deny', '裸路径相对工作区且不限深度');
  });

  it('`**` 跨层、`*` 不跨斜杠', () => {
    assert.equal(evaluateRules(user({ deny: ['read(**/node_modules/**)'] }), target('packages/a/node_modules/x'), ENV), 'deny');
    assert.equal(evaluateRules(user({ deny: ['read(src/*.ts)'] }), target('src/a/b.ts'), ENV), undefined, '* 不跨斜杠');
  });

  it('`!` 否定按 gitignore 的 last-match-wins', () => {
    const rules = user({ deny: ['read(*.env)', 'read(!sample.env)'] });
    assert.equal(evaluateRules(rules, target('a/.env'), ENV), 'deny');
    assert.equal(evaluateRules(rules, target('sample.env'), ENV), undefined, '被否定项排除');
  });

  it('项目级的否定项不能解除用户级的 deny', () => {
    const layers: RuleLayers = {
      user: { rules: { allow: [], ask: [], deny: ['read(*.env)'] }, sourceDir: '/home/u/.sph' },
      project: { rules: { allow: [], ask: [], deny: ['read(!sample.env)'] }, sourceDir: '/ws' },
    };
    assert.equal(evaluateRules(layers, target('a/.env'), ENV), 'deny');
  });

  it('allow 要求请求路径与真实路径都命中（软链不能借 allow 放行）', () => {
    const layers = user({ allow: ['read(src/**)'] });
    assert.equal(evaluateRules(layers, target('src/a.ts', '/ws/src/a.ts'), ENV), 'allow');
    assert.equal(evaluateRules(layers, target('src/a.ts', '/etc/passwd'), ENV), undefined);
  });

  it('deny 只要有一个命中就够（软链不能绕过）', () => {
    assert.equal(evaluateRules(user({ deny: ['read(//etc/**)'] }), target('src/a.ts', '/etc/passwd'), ENV), 'deny');
  });
});

describe('网络与 MCP 规则', () => {
  it('domain: 匹配主机名，`*.` 不匹配根域', () => {
    const layers = user({ allow: ['web_fetch(domain:*.example.com)'] });
    const fetch = (url: string) => evaluateRules(layers, { tool: 'web_fetch', command: url }, ENV);
    assert.equal(fetch('https://a.example.com/x'), 'allow');
    assert.equal(fetch('https://example.com/x'), undefined);
    assert.equal(evaluateRules(user({ deny: ['web_fetch(domain:*)'] }), { tool: 'web_fetch', command: 'https://x.dev' }, ENV), 'deny');
  });

  it('mcp 规则按 server 名匹配，`server` 与 `server.tool` 都行', () => {
    const layers = user({ allow: ['mcp(context7)'] });
    assert.equal(evaluateRules(layers, { tool: 'mcp', command: 'context7.resolve' }, ENV), 'allow');
    const tool = user({ deny: ['mcp(docs.fetch)'] });
    assert.equal(evaluateRules(tool, { tool: 'mcp', command: 'docs.fetch' }, ENV), 'deny');
    assert.equal(evaluateRules(tool, { tool: 'mcp', command: 'docs.other' }, ENV), undefined);
  });
});

describe('分层求值', () => {
  const base: RuleLayers = {
    user: { rules: { allow: ['bash(npm *)'], ask: [], deny: [] }, sourceDir: '/home/u/.sph' },
    project: { rules: { allow: [], ask: [], deny: ['bash(npm publish *)'] }, sourceDir: '/ws' },
  };

  it('项目级 deny 压得住用户级 allow', () => {
    assert.equal(shell('npm publish --tag next', base), 'deny');
    assert.equal(shell('npm test', base), 'allow');
  });

  it('跨层也是 deny > ask > allow 的顺序', () => {
    const layers: RuleLayers = {
      user: { rules: { allow: ['bash(git *)'], ask: [], deny: [] }, sourceDir: '/home/u/.sph' },
      project: { rules: { allow: [], ask: ['bash(git push *)'], deny: [] }, sourceDir: '/ws' },
    };
    assert.equal(shell('git push origin main', layers), 'ask', '项目级 ask 先于用户级 allow');
  });

  it('deny 里裸工具名会让工具从集合里消失；带 specifier 的不会', () => {
    const layers = user({ deny: ['browser', 'mcp*', 'bash(rm *)'] });
    const kept = visibleTools(layers, new Set(['bash', 'browser', 'mcp', 'read']));
    assert.deepEqual([...kept].sort(), ['bash', 'read']);
  });
});

describe('只读命令集合', () => {
  it('常见只读命令与 git 只读子命令命中', () => {
    assert.equal(isReadOnlyCommand('ls -la'), true);
    assert.equal(isReadOnlyCommand('git status'), true);
    assert.equal(isReadOnlyCommand('git diff HEAD~1'), true);
    assert.equal(isReadOnlyCommand('cat a.txt | grep x'), true, '管道每一段都只读');
  });

  it('写盘、破坏性、非只读 git 子命令都不算', () => {
    assert.equal(isReadOnlyCommand('echo x > f.txt'), false);
    assert.equal(isReadOnlyCommand('ls | tee out.txt'), false);
    assert.equal(isReadOnlyCommand('find . -exec rm {} ;'), false);
    assert.equal(isReadOnlyCommand('sed -i s/a/b/ f'), false);
    assert.equal(isReadOnlyCommand('git commit -m x'), false);
    assert.equal(isReadOnlyCommand('git branch -D feature'), false);
    assert.equal(isReadOnlyCommand('cd /tmp && rm -rf x'), false, '有一段不读就不算只读');
    assert.equal(isReadOnlyCommand('npm test'), false);
    assert.equal(isReadOnlyCommand('cat a.txt > /tmp/x 2>&1'), false, '描述符复制不能赦免前面的写重定向');
    assert.equal(isReadOnlyCommand('cat a.txt 2>&1'), true, '单独的描述符复制不写盘');
    assert.equal(isReadOnlyCommand('echo "$(rm -rf /)"'), false, '引号里的命令替换会执行');
  });
});

describe('提议可复用规则', () => {
  it('取「程序 + 子命令」两段做前缀', () => {
    assert.equal(suggestAllowRule({ tool: 'bash', command: 'npm run build --watch' }), 'bash(npm run *)');
    assert.equal(suggestAllowRule({ tool: 'bash', command: 'git log --oneline' }), 'bash(git log *)');
    assert.equal(suggestAllowRule({ tool: 'mcp', command: 'context7.resolve' }), 'mcp(context7)');
  });

  it('破坏性命令、复合命令、含替换的命令一律不提议', () => {
    assert.equal(suggestAllowRule({ tool: 'bash', command: 'rm -rf build' }), undefined);
    assert.equal(suggestAllowRule({ tool: 'bash', command: 'npm test && rm -rf build' }), undefined);
    assert.equal(suggestAllowRule({ tool: 'bash', command: 'echo "$(date)"' }), undefined);
    assert.equal(suggestAllowRule({ tool: 'bash', command: 'cat <<EOF\nx\nEOF' }), undefined);
  });

  it('提议出来的规则本身可解析', () => {
    const rule = suggestAllowRule({ tool: 'bash', command: 'npm run build' })!;
    assert.doesNotThrow(() => parseRuleEntry(rule, 'allow', 'project', 'permissions.allow'));
  });
});

describe('HeadlessApprover', () => {
  it('deny 优先于一切，连 yolo 也绕不过', async () => {
    const approver = new HeadlessApprover('yolo', undefined, { layers: user({ deny: ['bash(rm *)'] }) });
    assert.equal(await approver.decide({ tool: 'bash', command: 'rm -rf /' }), false);
  });

  it('只读命令在所有模式下都放行；要拦就写 deny 规则', async () => {
    const ask = new HeadlessApprover('ask', undefined, { layers: user({}) });
    assert.equal(await ask.decide({ tool: 'bash', command: 'git status' }), true);
    const denied = new HeadlessApprover('ask', undefined, { layers: user({ deny: ['bash(git status)'] }) });
    assert.equal(await denied.decide({ tool: 'bash', command: 'git status' }), false);
  });

  it('路径规则按传入的 ruleEnv 锚定，省略环境时 ~/ 对不上主目录', async () => {
    const layers = user({ deny: ['read(~/.ssh/**)'] });
    const request = { tool: 'read', path: '/home/u/.ssh/id_rsa' };
    const anchored = new HeadlessApprover('ask', undefined, { layers, ruleEnv: ENV });
    assert.equal(await anchored.decide(request), false);
    const bare = new HeadlessApprover('ask', undefined, { layers });
    assert.equal(await bare.decide(request), true, 'home 为空时这条规则不该误命中，也不该被当成已锚定');
  });

  it('sandbox_auto_allow 打开且沙箱非 off 时，shell 命令免问', async () => {
    const env = { sandboxMode: () => 'workspace' as const, sandboxAutoAllow: () => true };
    const on = new HeadlessApprover('ask', undefined, { layers: user({}), ...env });
    assert.equal(await on.decide({ tool: 'bash', command: 'npm test' }), true);
    const off = new HeadlessApprover('ask', undefined, { layers: user({}), ...env, sandboxAutoAllow: () => false });
    assert.equal(await off.decide({ tool: 'bash', command: 'npm test' }), false, '默认关闭');
    const noSandbox = new HeadlessApprover('ask', undefined, {
      layers: user({}),
      sandboxMode: () => 'off' as const,
      sandboxAutoAllow: () => true,
    });
    assert.equal(await noSandbox.decide({ tool: 'bash', command: 'npm test' }), false, '沙箱关着就没有兜底');
  });
});
