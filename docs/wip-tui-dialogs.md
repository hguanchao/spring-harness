# 未完成：TUI 报告弹窗

2026-09-29 停下时的交接。`/skills` 的框尺寸、画布底、h3 横线标题已经落地；下面两件没做完。

对照物在 `commandSkills()`（`src/plugins/sph-tui/interactive-mode.ts`）：

- 宽 `60%`，`maxWidth: 10_000`（宽终端不被档位上限夹住）
- 高 `75%`，顶边距屏幕 10%（`row: floor(terminal.rows * 0.1)`）
- `transparent: true`：铺画布底（`theme.bg`），不铺浮层面 `dialogBg`
- 边框标题只写名字（`Skills` / `Help` / `Plugins`）
- 正文先一段说明，再用 `### 段名 数量`；渲染时画成 `—— 段名 5 ———`，破折号铺满内容宽（见 `ruleHeadingLine`，`src/tui/widgets/markdown.ts`）

---

## 1. 技能条目路径改中性灰

**要改的：** `/skills` 列表里每一条技能**下面那一行路径**的颜色。  
**不要改：** `### Loaded from` 下面的根目录列表（继续走 `{{…}}` 蓝码）。

现状：两条都走 `secondary()` → `{{path}}` → markdown 主题 `secondary` 画成 `mdCode` 蓝（`#5c9cf5`）。

```79:88:src/plugins/sph-tui/commands/reports.ts
    for (const skill of catalog) {
      lines.push(`- ${code(skill.name)} — ${plain(skill.description)}`);
      lines.push(`  ${secondary(skill.path)}`);
    }
  }

  lines.push('', '### Loaded from', '', 'Later roots override earlier ones when two skills share a name.', '');
  roots.forEach((root, index) => {
    lines.push(`${index + 1}. ${secondary(root)}`);
```

做法（二选一，别把 `secondary` 主题整段改灰，会把 Loaded from 一起带上）：

- 技能路径改成斜体正文（`theme.muted` / `#6c6c6c`），例如 `` `_path_` `` 或单独一种标记；
- 或给 markdown 再加一档内联标记（灰），技能路径用新标记，Loaded from 仍用 `{{…}}`。

测：`tests/plugins/sph-tui/commands/reports.test.ts`（路径仍在、Loaded from 的 `{{…}}` 仍在）、必要时在 `dialog-render.test.ts` 断言技能路径行含 muted 色、Loaded from 行仍含 `mdCode`。

---

## 2. `/help`、`/plugins` 弹窗对齐 `/skills`

用户原话：命令 help 和命令 plugins 的弹窗，参考 skills 的弹窗去改造。

### `/plugins`（只读报告，最接近 skills）

现状：`showMessageDialog`，走 document 档默认宽高（88% / 上限 100 / 88% 高），铺浮层灰，正文以 `## Plugins (N)` 开头。

要做：

1. `commandPlugins()` 套上 skills 同一套浮层选项：`width: '60%'`、`maxWidth: 10_000`、`maxHeight: '75%'`、`row: 10%`、`transparent: true`。
2. `renderPluginsReport` 去掉顶栏 `## Plugins (N)`；先写一段说明（空目录那段可以留着），再 `### Plugins ${n}`，下面仍是每个插件一块 `### sph-mcp`。h3 横线已经是全局的，源码继续写 `###` 即可。
3. 测试：`tests/plugins/sph-tui/commands/reports.test.ts` 里对 `## Plugins (` 的断言改成 `### Plugins N`；`dialog-render.test.ts` 的 `/plugins` 用例改成认横线标题、画布底，不再认 `Plugins (N)`。

### `/help`（现在是选择框，不是报告框）

现状：`showSelectDialog`，命令按组列出，Enter 直接执行；键位 / 队列 / 编辑器是不可选的 doc 行。这是交互面板，不是 markdown 报告。

要对齐 skills，需要先定交互：

- **A（推荐先做框，再议交互）：** 选择框也套 skills 的宽高、顶距、画布底；分组标题若能走同一套横线最好，走不了就先只改框。Enter 执行保留。
- **B：** 改成 `showMessageDialog` markdown 报告（`### Commands N`、`### Keys`、`### Queue`、`### Editor`），失去点选执行。若走这条，`buildHelpPanelItems` 要改成纯文本生成函数，测 `commandHelp` 不再依赖 SelectDialog。

选择框目前没有 `transparent` / `maxWidth` / `row`（见 `showSelectDialog`）。若走 A，这些选项要补到 `showSelectDialog`，别把审批、确认框一起改成透空。

`buildHelpPanelItems` 现在长在 `interactive-mode.ts`（约 125–197 行）。改成报告的话，抽到 `commands/reports.ts` 旁边，方便单测。

---

## 相关文件

| 文件 | 角色 |
|---|---|
| `src/plugins/sph-tui/interactive-mode.ts` | `commandHelp` / `commandPlugins` / `commandSkills` |
| `src/plugins/sph-tui/commands/reports.ts` | skills / plugins / mcp 正文 |
| `src/plugins/sph-tui/dialogs.ts` | `showMessageDialog` / `showSelectDialog` |
| `src/tui/widgets/markdown.ts` | h3 → `—— 标题 ———` |
| `src/plugins/sph-tui/theme/theme.ts` | `secondary` 现为蓝码 |
| `tests/plugins/sph-tui/commands/reports.test.ts` | 报告文本 |
| `tests/plugins/sph-tui/dialog-render.test.ts` | `/skills` `/plugins` 真渲染 |
