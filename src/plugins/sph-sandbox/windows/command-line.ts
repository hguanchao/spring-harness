/**
 * Windows 命令行的参数编码。
 *
 * 单独成模块（不 import win32.js）是刻意的：这段是**纯字符串逻辑**，也是 spawn 路径里最容易
 * 写错的一段，放在这里就能在任何平台上被测试覆盖——spawn.ts 一旦 import koffi，非 Windows
 * 连模块都加载不了，测试只能整条跳过。
 *
 * 规则来自解析侧（CommandLineToArgvW）：CreateProcess 只把 lpCommandLine 当字符串拼接，
 * 转义与拆分发生在子进程侧。关键一点是**反斜杠只有在紧跟引号时才有转义含义**：
 * - `\"` = 一个字面引号；
 * - 所以引号前的连续反斜杠必须翻倍，否则它们会把引号「吃掉」；
 * - 参数末尾的反斜杠同理——它紧邻收尾引号，不翻倍就会把收尾引号转义掉，整段拼错位。
 *
 * 这正是 Python `subprocess.list2cmdline` 用的算法。
 */
export function quoteCommandLineArg(arg: string): string {
  // 空串必须引起来（否则直接消失）；不含空格/制表符/引号时原样输出即可。
  if (arg !== '' && !/[ \t"]/u.test(arg)) return arg;

  let out = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') {
      // 引号前的反斜杠翻倍，再补一个转义用的反斜杠。
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  // 收尾：末尾攒下的反斜杠会顶到收尾引号上，必须翻倍。
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}
