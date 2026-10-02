/**
 * 会话文件的格式版本与迁移。
 *
 * ## 为什么需要版本号
 *
 * 会话文件是**长期资产**：`~/.sph/sessions` 里的东西比任何一次发布都活得久。而格式一定会变
 * ——`images` / `documents` / `attachments` / `reasoning` / `thinking` 都是陆续加上去的。
 * 只加字段时，「字段可选 + 坏行跳过」能吸收变化；一旦**字段的含义**变了（而不只是出现），
 * 旧记录就会被静默读错，而坏行跳过意味着连数据丢了都看不见。版本号把这种变化从猜测变成一条
 * 可查证的事实：这段字节属于哪一代、该用哪一代的规则解释。
 *
 * ## 头部记录
 *
 * 版本落在文件**第一行**的一条 `{"type":"session", version, id, createdAt}` 上，而不是
 * 一个单独的 meta 文件：会话文件是可以被拷来拷去、贴进 issue、当语料的单个文件，自描述
 * 才搬得动。
 *
 * 向后兼容是免费拿到的：旧的读取器只认 `type` 为 `message` / `event` 的行，头部会被
 * `parseSessionLine` 判为「形状不对」而**跳过**——所以新版写的文件在旧版里仍能读，
 * 只是看不见版本。反过来，**没有头部即 v1**：这是所有已存在的会话文件。
 *
 * 有意不写 `workspaceRoot`：它会泄漏本地路径，而会话文件是最可能被分享出去的那份东西。
 * 工作区归属在 `current.json` 里，那本来就是每机器一份、不对外的东西。
 *
 * ## 迁移
 *
 * 读的时候按注册表**逐代 upcast**，写的时候永远只写当前版本。所以迁移只需要写一次，
 * 而且每一条都能被语料钉住（见 `tests/plugins/sph-session/replay.test.ts`）。
 *
 * 与参考项目的取舍：dsh 把每一代迁移做成独立冻结包，并规定已提交的世代永不改名（316 个包、
 * 多人并行下的必要成本）。sph 的迁移表就在这一处、代码量一目了然——单作者项目里，
 * 「能一口气读完」比「每代独立发版」值钱。
 */

import type { SessionRecord } from './types.js';

/** 当前写出的版本。改格式时 +1，并在 {@link MIGRATIONS} 里补一条 v(n-1)→v(n)。 */
export const SESSION_FORMAT_VERSION = 2;

/** 会话文件第一行的头部记录。不属于 `SessionRecord`：它是存储层的元数据，不是对话内容。 */
export interface SessionHeader {
  type: 'session';
  version: number;
  id?: string;
  createdAt?: string;
}

/** 构造头部。`id` 与文件名同源，冗余写一份是为了让单独传出去的文件仍能自报身份。 */
export function sessionHeader(meta: { id: string; createdAt?: string }): SessionHeader {
  return {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: meta.id,
    ...(meta.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
  };
}

/** 认头部记录；形状不对返回 undefined。只认 `version` 是正整数的那些。 */
export function asSessionHeader(record: unknown): SessionHeader | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const candidate = record as { type?: unknown; version?: unknown; id?: unknown; createdAt?: unknown };
  if (candidate.type !== 'session') return undefined;
  if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version) || candidate.version < 1) {
    return undefined;
  }
  return {
    type: 'session',
    version: candidate.version,
    ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
    ...(typeof candidate.createdAt === 'string' ? { createdAt: candidate.createdAt } : {}),
  };
}

/**
 * v1 → v2：把无 id 的线性前缀接进会话树。
 *
 * v1 记录没有 `id` / `parentId`（树形是后来加的），读法一直是「无 id 的记录视为线性前缀，
 * 永远整段保留」（见 tree.ts 的 lineage）。那条特例让每个读点都得记得它存在。
 *
 * 这条迁移把特例**变成数据**，且**语义等价**：给前缀按序补上合成 id 与父子链，再把树里
 * 第一个根（`parentId` 为空的那条）改挂到前缀尾部。迁移后从 tip 走到根就会自然穿过前缀，
 * 不再需要任何特例。等价的证据在语料里：`linear-legacy` 与「同一段内容但带 id」的会话，
 * 迁移后必须投影出完全相同的消息序列。
 *
 * 合成 id 用 `legacy<n>` 前缀：真实 id 是 4 位十六进制（见 newEntryId），不可能撞上。
 */
function linearToTree(records: readonly SessionRecord[]): SessionRecord[] {
  const legacy = records.filter((record) => record.id === undefined);
  if (legacy.length === 0) return [...records];

  const out: SessionRecord[] = [];
  let previousId: string | null = null;
  for (let i = 0; i < legacy.length; i++) {
    const id = `legacy${i}`;
    out.push({ ...legacy[i]!, id, parentId: previousId });
    previousId = id;
  }

  // 树里第一个没有父的节点，就是前缀之后的那条：把它挂到前缀尾部。
  let reattached = false;
  for (const record of records) {
    if (record.id === undefined) continue;
    if (!reattached && (record.parentId === null || record.parentId === undefined)) {
      out.push({ ...record, parentId: previousId });
      reattached = true;
      continue;
    }
    out.push(record);
  }
  return out;
}

interface Migration {
  from: number;
  to: number;
  /** 就地语义：输入不被修改，返回新数组。 */
  apply(records: readonly SessionRecord[]): SessionRecord[];
}

/** 按 from 升序；读取时从文件声明的版本一路 upcast 到当前版本。 */
const MIGRATIONS: readonly Migration[] = [{ from: 1, to: 2, apply: linearToTree }];

/**
 * 把记录迁移到当前版本。
 *
 * 版本比当前**新**时原样返回：那是「被新版写过、又被旧版打开」的文件。不猜、不报错——
 * 读得出来的部分照读（未知字段本就忽略，未知事件类型本就跳过），这比拒绝打开一个会话更有用。
 */
export function migrateRecords(records: readonly SessionRecord[], fromVersion: number): SessionRecord[] {
  if (fromVersion >= SESSION_FORMAT_VERSION) return [...records];
  let current = [...records];
  let version = fromVersion;
  while (version < SESSION_FORMAT_VERSION) {
    const step = MIGRATIONS.find((migration) => migration.from === version);
    if (!step) break;
    current = step.apply(current);
    version = step.to;
  }
  return current;
}

/** 头部缺席时的版本：所有早于版本号存在的会话文件。 */
export const IMPLICIT_VERSION = 1;
