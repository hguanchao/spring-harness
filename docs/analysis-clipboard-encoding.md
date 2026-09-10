# TUI 复制中文乱码：根因分析

分析对象：`src/tui/clipboard.ts`（本轮新增的剪贴板写入）。
现象：拖动选中中文并松开后，粘贴出来是乱码（如 `混合 ASCII 与中�?`）。

> **状态：已修复（方案 A 已落地）**
>
> - `src/tui/clipboard.ts`：Windows 路径从 `clip.exe` 换成
>   `powershell.exe -Command "[Console]::InputEncoding=UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"`；
>   `writeClipboard` 返回值由 `boolean` 改为三态 `'native' | 'osc52' | 'none'`，原生命令优先。
> - `src/tui/app.ts`：`copySelection()` 按三态给诚实提示（不再把 OSC 52 的「发过了」当「已复制」）。
> - `test/verify-tui.ts`：新增 Windows 专属**往返一致性**检查（7 个用例，跑完恢复原剪贴板），
>   并把 `copyCommand('win32')` 断言改成「必须 PowerShell + `InputEncoding = UTF8` + `Set-Clipboard`，不得含 `clip`」。
> - 全量门槛：`tsc --noEmit` 0 错误；`verify:tui` **82 项**、`verify-core` 16 项、
>   `verify:mcp` 3 项、`verify:markdown` 25 项全绿；`npm run build` 通过。

## 一句话结论

**不是我们的编码错了，是 `clip.exe` 的 stdin 编码规则比想象中复杂。**
`clip.exe` 在中文 Windows（代码页 936 / GBK）下会**按控制台当前代码页解释 stdin 字节**，
而 Node 送进去的是 UTF-8 —— 两套编码一错位就成乱码。而且它的行为**不是简单的"按 GBK 读"**，
还混着 BOM 判定与流式解码，所以表现出"有时对、有时错、错的位置还随机"。

---

## 复现与定位

### 环境

```
系统代码页: 936（GBK）
Node: 22.22.2
```

### 实测：同一段中文，三种喂法

| stdin 内容 | `clip.exe` 读出的结果 | 结论 |
| :--- | :--- | :--- |
| UTF-8 无 BOM（**当前实现**） | `混合 ASCII 与中�?` | ❌ 乱码 |
| UTF-8 带 BOM | `﻿混�?ASCII 与中�?` | ❌ 乱码，BOM 还变成了可见字符 |
| UTF-16LE 带 BOM | `?��� ASCII ������` | ❌ 乱码 |

**三种都错**，说明问题不在"挑一个正确编码"，而在 `clip.exe` 本身不可靠。

### 更细的观测（解释"为什么有时对"）

同一份代码，短文本对、长文本错：

| 文本 | utf8 字节数 | 结果 |
| :--- | ---: | :--- |
| `中文测试复制 abc` | 22 | ✅ 正确 |
| `中文测试复制` | 18 | ✅ 正确 |
| `混合 ASCII 与中文` | 22 | ❌ `混合 ASCII 与中�?` |
| `多行\n第二行` | 16 | ❌ `第二�?` |
| `混合 ASCII 与中文测试` | 28 | ❌ `混合 ASCII 与中文测�?` |

注意错的总在**结尾**，且会**吃掉/替换最后半个字**——这是"流式按代码页解码"的典型特征：
`clip.exe` 大概率是逐块读 stdin、逐块按当前代码页转换，**跨读取块边界的多字节字符会被劈开**，
劈开的那半个字符就变成替换字符 `�`。

**这个 bug 的隐蔽性**：全中文短文本常常是对的，只有**中英混排**或**够长**时才会暴露。
所以它不是"每次都乱码"，而是"偶尔崩一个字"——这类 bug 最难被用户描述清楚，也最容易漏测。

---

## 为什么之前没发现

我们**已有的测试完全没覆盖这条路径**：

- `verify-tui.ts` 里复制相关的 E2E 用的是 `SPH_CLIPBOARD=osc52`，
  即**只发 OSC 52 报文、不起子进程**。当时加这个开关是为了避免测试污染用户剪贴板，
  副作用是**把出问题的那条路径整个屏蔽掉了**。
- 单测断言的是 `osc52('hi')` 的 base64 与 `copyCommand()` 返回的命令名，
  **没有一条断言检查"写进去的中文能不能原样读出来"**。

教训：**为了不污染环境而绕开的路径，必须另找方式验证**，否则等于没测。

---

## 修法

### 方案 A（✅ 已实施）：Windows 改走 PowerShell 的 `Set-Clipboard`

这是 opencode 的选择（`packages/tui/src/clipboard.ts:86-94`）：

```ts
if (os === "win32" && has("powershell.exe")) {
  return ["powershell.exe", "-NonInteractive", "-NoProfile", "-Command",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8;" +
    "Set-Clipboard -Value ([Console]::In.ReadToEnd())"];
}
```

关键在 **`[Console]::InputEncoding = UTF8`**：它显式把 stdin 的编码钉死为 UTF-8，
消除了"按控制台代码页猜"这段不确定性。`Set-Clipboard` 直接操作 Win32 剪贴板 API，
写的是真正的 `UnicodeText` 格式，不经过 OEM 代码页转换。

代价：PowerShell 启动约 200-400ms（比 `clip.exe` 慢一个数量级）。
但复制是**用户主动操作**、不是热路径，这个延迟可接受。

### 方案 B：坚持用 `clip.exe`，但先 `chcp 65001`

在写之前切到 UTF-8 代码页。**不推荐**：

- `chcp` 是进程级状态，改的是**整个控制台**的代码页，会影响同时运行的其他程序。
- 恢复时机不可靠（异常退出就留在了 65001）。
- 仍然是"猜"，只是换了个猜法。

### 方案 C（后续可选硬化）：绕过命令行工具，直接用原生剪贴板 API

项目已有 `koffi`（N-API 预编译 addon），可以调 `user32.dll` 的
`OpenClipboard` / `SetClipboardData(CF_UNICODETEXT, ...)` / `CloseClipboard`。
**最正确、最快**（无子进程），但要写约 40 行 FFI 绑定 + 内存分配/释放，
且要在 `finally` 里保证 `CloseClipboard`。收益是彻底摆脱子进程与文本编码转换。

**已选的路线**：落 A（改动最小、立刻可用），把 C 记成后续可选的硬化项。

---

## 顺带修掉的：OSC 52 的静默失败（✅ 已完成）

`writeClipboard` 目前把 `osc52` 是否发送成功当成"成功"：

```ts
try {
  process.stdout.write(sequence);
  osc = true;        // ← 只是"写进 stdout 没抛异常"，不代表终端真的处理了
} catch { osc = false; }
```

OSC 52 是**只写通道**，终端支不支持、有没有真的写进剪贴板，我们**根本收不到反馈**。
Windows Terminal 早期版本默认禁用 OSC 52，此时这条路是静默失败的。

**后果**：`both` 模式下即便 `clip.exe` 写错了内容，`|| osc` 也会让它返回 `true`，
界面提示"已复制到剪贴板" —— **用户以为复制成功了，粘贴出来却是乱码**。
这正是本次 bug 的观感来源（有成功提示 + 内容是坏的）。

修法：`both` 模式下以**原生命令的退出码为准**，OSC 52 只当补充；
只有原生命令不可用时才退回 `osc52` 的结果。并在两条都不可靠时给出更明确的提示。

---

## 验证计划（✅ 已实施）

修好之后补上的测试：

1. **往返一致性**：`writeClipboard(中文) → 用独立通道读回 → 逐字符比对`。
   覆盖纯中文 / 中英混排 / 多行 / emoji / 空串 / 超长文本。
2. **单测守住编码**：断言 `copyCommand('win32')` 包含 `InputEncoding = UTF8`
   （防止有人"优化"回 `clip.exe`）。
3. **`both` 模式的返回值语义**：原生命令失败时不该因为 OSC 52 "发过" 就报成功。

⚠️ 测试会真的改系统剪贴板。做法：跑完**恢复原内容**（先读出来、结束后写回），
而不是像现在这样一刀切成 `osc52` 把路径屏蔽掉。

**实施中的两个坑（已解决，记下来防再犯）：**

- **读回要只砍一个行尾换行**。PowerShell 每次都在末尾补一个换行（是命令输出的换行，
  不是剪贴板内容）。用 `replace(/\s+$/, '')` 会把 `'  两侧有空格  '` 的尾部空格一起裁掉，
  断言失败时看起来像"写入方丢了空格"，指错方向；正解是 `replace(/\r?\n$/, '')`。
- **这条检查必须放在文件最末尾**。它起子进程、有几百毫秒 wall-clock 延迟，而 E2E 用的是
  **假 TTY + 定时器驱动**；插在 E2E 之间时，前面的主循环还活在后台、`process.stdin` 仍挂着
  data 监听，会被等待时间牵着走，表现成"读回来的内容整段错位成别的字符串"（实测读到了
  上一次 E2E 留下的仓库 remote URL），极难定位。放到最后就没有共享时序可争。

---

## 一句话给用户

`clip.exe` 不保证按 UTF-8 读 stdin，它在中文系统上按 GBK 流式解码，
跨块边界的中文字会被劈开成 `�`。修法是把 Windows 路径换成
`powershell -Command "[Console]::InputEncoding=UTF8; Set-Clipboard ..."`
（opencode 也是这么做的），并让提示以原生命令的退出码为准，避免"假成功"。

