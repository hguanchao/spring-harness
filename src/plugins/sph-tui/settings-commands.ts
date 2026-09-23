/**
 * 模型与审批设置命令域：/model、/provider、/effort、/permission。
 *
 * 负责列表/向导的弹窗交互与候选装配；选择的应用（重建 client、落事件、写回
 * config.toml / models.json）收口到宿主的 apply* 回调——这些是跨字段的状态突变，
 * 命令层只回答「用户选了什么」。
 */

import { API_PROTOCOLS, type ApiProtocol } from '../../config/load.js';
import { appendModelDeclaration, splitProviderModel, type ProviderDeclaration } from '../../config/registry.js';
import { sphModelsPath } from '../../home.js';
import { displayNameForModel, listAvailableModels } from '../sph-llm/models.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../sph-llm/openai.js';
import { APPROVAL_MODES, type ApprovalMode } from '../../permission/policy.js';
import { errorMessage } from '../../util.js';
import { primaryColumnWidthFor } from './commands.js';
import type { TUI, SelectItem } from './screen/index.js';
import type { TuiDeps } from './deps.js';
import { showInputDialog, showLoadingDialog } from './dialogs.js';
import { visibleWidth } from './screen/utils.js';
import type { CustomEditor } from './components/custom-editor.js';

/** `/provider` 拉上游目录的超时。刻意短：不少中转站根本没有 /models 目录端点（返回 502 或干脆挂住），走代理时 CONNECT 隧道也会拖很久。目录只是发现手段，降级路径（已声明 + 手动输入）才是兜底。 */
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

/** 设置命令需要的宿主能力。 */
export interface SettingsCommandHost {
  editor: Pick<CustomEditor, 'showInlineMenu'>;
  ui: TUI;
  deps: TuiDeps;
  addNotice(text: string, level?: 'dim' | 'warn' | 'error' | 'success'): void;
  currentProvider(): string;
  currentModel(): string;
  currentEffort(): ReasoningEffort | undefined;
  currentApproval(): ApprovalMode;
  /** 应用模型选择：重建 client、记事件、写回配置（可能同时切换 provider）。 */
  applyModel(model: string, providerName?: string): void;
  applyEffort(effort: ReasoningEffort): void;
  /** 把协议写到该模型的声明上（覆盖 provider 默认）并立刻重建 client。 */
  applyApi(api: ApiProtocol, provider: ProviderDeclaration, modelId: string): void;
  applyApproval(mode: ApprovalMode): void;
}

export async function commandModel(host: SettingsCommandHost, argument = ''): Promise<void> {
  if (argument !== '') {
    host.applyModel(argument);
    return;
  }
  // 候选只来自 models.json 的声明：模型目录是显式维护的清单，不再从上游拉取缓存——
  // 上游会新增模型，而拉一次就存住的缓存只会静默地给出旧列表。
  const providers = host.deps.models();
  if (providers.length === 0) {
    host.addNotice('No models declared in models.json.', 'warn');
    return;
  }
  // description 列内排三段：模型 ID / 提供商 / 状态。各段按最宽值 pad（间隙 2），
  // 加上 label 列就是四列；中文名混排时字符数不等于显示宽，按 visibleWidth 对齐才不会锯齿。
  const widthOf = (text: string): number => visibleWidth(text);
  const idColumnWidth = Math.max(...providers.flatMap((provider) => provider.models.map((row) => widthOf(row.id))));
  const providerColumnWidth = Math.max(...providers.map((provider) => widthOf(provider.name)));
  const labelColumnWidth = Math.max(
    ...providers.flatMap((provider) =>
      provider.models.map((row) => widthOf(row.name ?? displayNameForModel(row.id))),
    ),
  );
  const padTo = (text: string, width: number): string => `${text}${' '.repeat(width - widthOf(text) + 2)}`;
  const items: SelectItem[] = providers.flatMap((provider) =>
    provider.models.map((declared) => {
      const value = provider.name === host.currentProvider() ? declared.id : `${provider.name}/${declared.id}`;
      const isCurrent = provider.name === host.currentProvider() && declared.id === host.currentModel();
      return {
        value,
        label: declared.name ?? displayNameForModel(declared.id),
        description: `${padTo(declared.id, idColumnWidth)}${padTo(provider.name, providerColumnWidth)}${
          isCurrent ? 'current' : ''
        }`.trimEnd(),
      };
    }),
  );
  if (items.length === 0) {
    host.addNotice('No models declared in models.json.', 'warn');
    return;
  }
  const selected = await host.editor.showInlineMenu({
    title: 'Model',
    items,
    maxVisible: 14,
    // 主列贴内容收紧：默认 32 列会让短模型名后面拖一长条空白，四列观感才散。
    primaryColumnWidth: labelColumnWidth + 2,
  });
  if (!selected || selected.value === `${host.currentProvider()}/${host.currentModel()}`) return;
  const { provider, model } = splitProviderModel(providers, selected.value);
  host.applyModel(model, provider);
}

/**
 * `/provider [name]`：切换 provider 的四步向导。
 *
 * 选 provider（带参数则跳过）→ 选模型 → 选推理等级 → 选端点协议。
 * 后两步 Esc 跳过，不影响已经生效的前几步。模型候选 = 已声明 ∪ 上游目录，
 * 选到未声明的就追加进 models.json 再切换。上游拉取失败不算失败：离线时
 * 仍能在已声明模型里切换，不该被一次网络故障挡住。
 */
export async function commandProvider(host: SettingsCommandHost, argument = ''): Promise<void> {
  const providers = host.deps.models();
  // 列对齐基元：两处菜单（provider 选择、模型选择）共用同一套宽与 pad。
  const widthOf = (text: string): number => visibleWidth(text);
  const padTo = (text: string, width: number): string => `${text}${' '.repeat(width - widthOf(text) + 2)}`;
  let targetName = argument.trim();
  if (targetName === '') {
    // description 排两段：baseUrl / 状态，各按最宽值对齐，current 不会锯齿。
    const baseUrlColumnWidth = Math.max(...providers.map((provider) => widthOf(provider.baseUrl)));
    const items: SelectItem[] = providers.map((provider) => ({
      value: provider.name,
      label: provider.name,
      description: `${padTo(
        provider.baseUrl,
        baseUrlColumnWidth,
      )}${provider.name === host.currentProvider() ? 'current' : ''}`.trimEnd(),
    }));
    const selected = await host.editor.showInlineMenu({
      title: 'Provider',
      items,
      maxVisible: 14,
      primaryColumnWidth: primaryColumnWidthFor(items),
    });
    if (!selected) return;
    targetName = selected.value;
  }
  const provider = providers.find((item) => item.name === targetName);
  if (!provider) {
    host.addNotice(
      `Unknown provider: ${targetName} (declared in models.json: ${providers.map((item) => item.name).join(', ')})`,
      'warn',
    );
    return;
  }

  // 拉取过程用弹窗呈现：通知行会一闪而过且被打断，模态加载框让「正在等网络」这件事显式化。
  const loading = showLoadingDialog(host.ui, {
    title: provider.name,
    text: `Fetching models from ${provider.baseUrl}…`,
  });
  let fetched: readonly string[] = [];
  let catalogUnavailable = false;
  try {
    fetched = await listAvailableModels(provider.baseUrl, provider.apiKey, {
      headers: provider.headers,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // 不少中转站没有 /models 目录端点（502 或挂住），这不是异常路径而是常态，
    // 所以把「Esc 后手动输入」一并说清，而不是只报错。
    catalogUnavailable = true;
    host.addNotice(
      `Fetch failed (${errorMessage(error)}) — the gateway may not offer a /models endpoint. Pick a declared model, or press Esc to type a model id.`,
      'warn',
    );
  } finally {
    loading.hide();
  }
  const declaredIds = new Set(provider.models.map((row) => row.id));
  // 候选 = 已声明 ∪ 上游目录去重。是否已声明对选择行为没有差别（未声明的选中即追加），
  // 所以不做 declared 标记——列表只回答「模型 ID 是什么、当前用的是哪个」两件事。
  const candidates = [
    ...provider.models.map((row) => ({ id: row.id, name: row.name })),
    ...fetched
      .filter((id) => !declaredIds.has(id))
      .map((id) => ({ id, name: undefined })),
  ];
  // description 列排两段：模型 ID / 状态，各按最宽值 pad（间隙 2），label 列随内容收紧。
  const idColumnWidth = Math.max(...candidates.map((candidate) => widthOf(candidate.id)));
  const labelColumnWidth = Math.max(
    ...candidates.map((candidate) => widthOf(candidate.name ?? displayNameForModel(candidate.id))),
  );
  const items: SelectItem[] = candidates.map((candidate) => {
    const isCurrent = provider.name === host.currentProvider() && candidate.id === host.currentModel();
    return {
      value: candidate.id,
      label: candidate.name ?? displayNameForModel(candidate.id),
      description: `${padTo(candidate.id, idColumnWidth)}${isCurrent ? 'current' : ''}`.trimEnd(),
    };
  });
  let selected = await host.editor.showInlineMenu({
    title: `Model @ ${provider.name}`,
    items,
    maxVisible: 14,
    primaryColumnWidth: labelColumnWidth + 2,
  });
  if (!selected && catalogUnavailable) {
    // 目录拉不到时的兜底：直接键入网关侧的模型 id，随后照样追加进 models.json。
    const typed = await showInputDialog(host.ui, {
      title: `Model id @ ${provider.name}`,
      hint: 'Type the model id exactly as the gateway expects it',
    });
    if (typed === undefined || typed.trim() === '') return;
    selected = { value: typed.trim(), label: typed.trim() };
  }
  if (!selected) return;
  const modelId = selected.value;
  if (!declaredIds.has(modelId)) {
    try {
      // 只追加当前选中的这一条，不把上游目录整表写进 models.json。
      appendModelDeclaration(sphModelsPath(), provider.name, modelId);
      host.addNotice(`Declared ${modelId} under ${provider.name} in models.json.`, 'success');
    } catch (error) {
      host.addNotice(`Failed to append ${modelId} to models.json: ${errorMessage(error)}`, 'warn');
    }
  }
  host.applyModel(modelId, provider.name);
  const effort = await promptEffort(host);
  if (effort !== undefined) host.applyEffort(effort);
  const api = await promptApi(host, host.deps.resolveModel(modelId, provider.name).api);
  if (api !== undefined) host.applyApi(api, provider, modelId);
}

export async function commandEffort(host: SettingsCommandHost, argument = ''): Promise<void> {
  if (argument !== '') {
    const match = REASONING_EFFORTS.find((effort) => effort === argument);
    if (!match) {
      host.addNotice(`Unknown effort: ${argument} (${REASONING_EFFORTS.join(' | ')})`, 'warn');
      return;
    }
    host.applyEffort(match);
    return;
  }
  const selected = await promptEffort(host);
  if (selected !== undefined) host.applyEffort(selected);
}

async function promptEffort(host: SettingsCommandHost): Promise<ReasoningEffort | undefined> {
  const items: SelectItem[] = REASONING_EFFORTS.map((effort) => ({
    value: effort,
    label: effort,
    description: effort === host.currentEffort() ? 'current' : undefined,
  }));
  const selected = await host.editor.showInlineMenu({
    title: 'Reasoning effort',
    items,
    maxVisible: 6,
    primaryColumnWidth: primaryColumnWidthFor(items),
  });
  return selected === undefined ? undefined : (selected.value as ReasoningEffort);
}

async function promptApi(host: SettingsCommandHost, current: ApiProtocol): Promise<ApiProtocol | undefined> {
  const items: SelectItem[] = API_PROTOCOLS.map((api) => ({
    value: api,
    label: api,
    description: api === current ? 'current' : undefined,
  }));
  const selected = await host.editor.showInlineMenu({
    title: 'API protocol',
    items,
    maxVisible: 3,
    primaryColumnWidth: primaryColumnWidthFor(items),
  });
  return selected === undefined ? undefined : (selected.value as ApiProtocol);
}

/**
 * `/permission [mode]`：无参数打开选择器，带参数直接设。
 *
 * 命令名对齐 dsh 的 `/permission`；写回的配置键仍是 `approval`——那是「审批策略」这个
 * 概念的名字，而且已经躺在用户既有的 config.toml 里，跟着改名会静默丢掉他们的设置。
 */
export async function commandPermission(host: SettingsCommandHost, argument = ''): Promise<void> {
  if (argument !== '') {
    const match = APPROVAL_MODES.find((mode) => mode === argument);
    if (!match) {
      host.addNotice(`Unknown approval mode: ${argument} (${APPROVAL_MODES.join(' | ')})`, 'warn');
      return;
    }
    host.applyApproval(match);
    return;
  }
  const items: SelectItem[] = APPROVAL_MODES.map((mode) => ({
    value: mode,
    label: mode,
    description:
      mode === 'ask'
        ? 'Ask before every reviewed tool call'
        : mode === 'auto'
          ? 'Let a model reviewer decide, escalate to you when unsure'
          : 'Approve everything automatically',
  }));
  const selected = await host.editor.showInlineMenu({ title: 'Approval mode', items, maxVisible: 3, primaryColumnWidth: primaryColumnWidthFor(items) });
  if (!selected) return;
  host.applyApproval(selected.value as ApprovalMode);
}

/** Shift+Tab：在 ask → auto → yolo 间循环审批模式（复用 /permission 的应用逻辑）。 */
export function cycleApprovalMode(host: SettingsCommandHost): void {
  const current = host.currentApproval();
  const index = APPROVAL_MODES.indexOf(current);
  const next = APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length]!;
  host.applyApproval(next);
}
