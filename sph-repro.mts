import os from 'node:os';
import path from 'node:path';
import { WindowsAclSandbox } from './src/sandbox/windows/backend.js';

const workspaceRoot = ['E:', 'Projects', 'IdeaProjects', 'restful-helper'].join('\\');
const command = ['C:', 'Windows', 'System32', 'bash.exe'].join('\\');
const sandbox = new WindowsAclSandbox({
  mode: 'workspace',
  workspaceRoot,
  sphHomeDir: path.join(os.homedir(), '.sph'),
  tempDir: os.tmpdir(),
});
await sandbox.init();
try {
  const result = await sandbox.run({ command, args: ['-c', 'echo test'], cwd: workspaceRoot, timeoutMs: 30000 });
  console.log('exitCode:', result.exitCode);
  console.log('stdout hex:', Buffer.from(result.stdout, 'utf8').toString('hex'));
  console.log('stdout:', JSON.stringify(result.stdout));
  console.log('stderr:', JSON.stringify(result.stderr));
} finally {
  sandbox.dispose();
}
