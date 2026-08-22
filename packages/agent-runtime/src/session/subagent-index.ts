/**
 * @tabtin/agent-runtime — Subagent Index Writer（阶段 8 子 Agent 可观测性）
 *
 * 落盘形态：`{sessionDir}/{parentSessionId}/subagents.jsonl`
 *
 * 每一行是一个 JSON 对象（append-only），用来记录"父 session 派出过哪些子 Agent"。
 * 一次子 Agent 生命周期会写两条：
 *
 *   1. `phase: 'started'` —— forkQuery 进入瞬间。
 *   2. `phase: 'ended'`   —— 子 query 走完（含 cancelled / failed）。
 *
 * 不做 mutation —— 旧条目永远在那里，消费方按 (subSessionId, phase) 折叠即可。
 * 这样磁盘故障 / 进程崩溃留下的"只有 start 没有 end"也能被审计端识别。
 *
 * 为什么独立一个 writer 而不复用 EventStorage？
 *   - EventStorage 落 6 件套 stream envelope，schema 受 wire 协议约束；这里
 *     是父 session 的"子任务元数据"，与 envelope 解耦，独立 schema 更直白。
 *   - 父 session 已经持有自己的 EventStorage 写**父**事件，再混进子任务元
 *     数据会让 events.jsonl 失去单一关注点。
 *
 * 与现有 `subagents/agent-xxx/` 目录的关系：
 *   - 子 session 真实落盘仍在 `{sessionDir}/{parentSessionId}/subagents/agent-{childId}/`。
 *   - 本索引文件 `subagents.jsonl` 与 `subagents/` 子目录同级（位于父 session
 *     目录顶层），消费方可以从索引拿到 sessionDir 字段直接定位子目录。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SubagentIndexPaths {
  /**
   * 子 session 根目录相对父 session 目录的路径（譬如 `subagents/agent-{id}`）。
   *
   * **阶段 8 Review fix**：原版本存的是绝对路径（`/Users/{user}/Library/...`），
   * 用户导出 / 提 issue / 跨机迁移时会泄露用户名。改成相对路径后，消费方按
   * `{conversationsRoot}/{organizationId}/{sp}/sessions/{parentSessionId}/` + 字段拼即可。
   */
  sessionDir: string;
  /** 子旧 transcript messages.jsonl 相对路径。 */
  messagesPath: string;
  /** 子 message-blocks.jsonl 相对路径。新 sidechain 历史权威文件。 */
  messageBlocksPath?: string;
  /** 子 snapshots.jsonl 相对路径。 */
  snapshotsPath: string;
  /** 子 events.jsonl 相对路径。 */
  eventsPath: string;
}

export interface SubagentIndexStartEntry {
  phase: 'started';
  parentSessionId: string;
  /** 子 session 的 sessionId（= forkQuery 内部生成的 `agent-{childId}`）。 */
  subSessionId: string;
  /** 子 Agent 的 childId（raw uuid），与 SUBAGENT_STARTED.subagent_run_id 同源。 */
  childId: string;
  /** UI / 调试用短 id（childId 前 4 位）。 */
  shortId: string;
  /**
   * 阶段 8 Review fix：父 messages.jsonl 里 `agent` 工具调用 tool_use 块的 id。
   *
   * 让消费方能从父 messages 上某条 tool_use 反查到对应子 session（双向跳转）。
   * 上游链路：`agent-tool.ts` 接收到工具调用时拿到 toolCallId → `executeChildAgent`
   * 透传给 `forkQuery` → 落到本字段。父级直接调 `forkQuery` 而非走 agent 工具时
   * 字段可缺省（undefined）。
   */
  parentToolCallId?: string;
  /**
   * **W2 resume（2026-05-30）**：本 subSession 的运行序号——`1` = 首次 spawn，
   * `2+` = 第 N-1 次 resume 续跑。
   *
   * resume 会复用同一个 childId（=> 同一 `subSessionId` = `agent-{childId}`），
   * 于是 `recordStart` / `recordEnd` 会对同一 subSessionId 再写一对 started/ended。
   * 消费方若按 subSessionId 朴素折叠会被多组 started/ended 搞乱状态 / 孤儿判定，
   * 故引入 `runSeq` 让消费方能按 (subSessionId, runSeq) 配对、取最新 run 折叠
   * （见 `foldSubagentRuns`）。
   *
   * 缺省 / 旧条目无此字段时由消费方按 `1` 处理（向后兼容）。
   */
  runSeq?: number;
  /**
   * **W2 resume（2026-05-30）**：本 run 是「续跑」哪个 childId 的延续标记。
   *
   * 仅 resume run（`runSeq > 1`）存在，值 == `childId`（W2 只支持自身续跑，不做
   * self-fork 到新 id）。它是「这条 started/ended 属于一次 resume 而非首次 spawn」
   * 的显式面包屑，供 telemetry / UI 给「resumed」打标用；折叠状态仍以 `runSeq` 为准。
   */
  resumedFrom?: string;
  /** 任务文本（截断 500 字符避免索引爆炸）。 */
  task: string;
  /**
   * Group/Mission：子 Agent 的角色名/身份（主 Agent 经 `agent` 工具 `role` 参数
   * 指定，如「科普撰稿人」）。落归档让重启 / 刷新 / 切走再回后，从 subagents.jsonl
   * 重建 run 时仍能恢复角色名——否则 UI chip 只能回落「子 Agent · 短id」。
   * 缺省（旧条目 / 主 Agent 没填）时由消费方回落。
   */
  role?: string;
  /**
   * agent 工具 `description` 参数（简短标签 3-5 词）→ 子 Agent 卡片标题。落归档让
   * 重启 / 刷新 / 切走再回后历史回放仍显示标题，而非回落「子 Agent · 短id」。
   * 实时路径标题走 SUBAGENT_STARTED.label（同源 description），此字段补归档恢复。
   */
  label?: string;
  /**
   * ：命中 Space 模板时的 template_id / 版本 / 显示名。落归档让重启 /
   * 刷新后从 subagents.jsonl 重建 run 时仍能恢复「源自模板 · {name}」标注。
   * 非模板派发时缺省（undefined）。
   */
  templateId?: string;
  templateVersion?: number;
  templateName?: string;
  /** 子 Agent 实际跑的 model 字段。 */
  model: string;
  /** 起跑时刻（epoch ms）。 */
  createdAt: number;
  /** ISO timestamp，便于 grep。 */
  createdAtISO: string;
  /** 子 session 三件套相对父 session 目录的路径。 */
  paths: SubagentIndexPaths;
}

export interface SubagentIndexEndEntry {
  phase: 'ended';
  parentSessionId: string;
  subSessionId: string;
  childId: string;
  /**
   * **W2 resume（2026-05-30）**：与对应 `started` 行同序号，让消费方把同一
   * subSessionId 的多组 started/ended 按 run 配对。缺省 / 旧条目按 `1` 处理。
   */
  runSeq?: number;
  /** 结束状态：completed = 正常返回；failed = 抛错；cancelled = abort 终止。 */
  status: 'completed' | 'failed' | 'cancelled';
  endedAt: number;
  endedAtISO: string;
  /** 子 Agent 最终文本长度（截 finalText 取 length 即可，避免再存全文）。 */
  finalTextLength: number;
  /** 总耗时（ms），由 caller 计算 endedAt - startedAt 后填入。 */
  durationMs: number;
  /** 失败时的简短错误描述（截断 500 字符）。 */
  errorMessage?: string;
}

export type SubagentIndexEntry = SubagentIndexStartEntry | SubagentIndexEndEntry;

const TRUNCATE_TEXT_AT = 500;

function truncate(text: string, max = TRUNCATE_TEXT_AT): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

/** 行级宽容解析 subagents.jsonl 文本为条目数组（坏行 silent skip）。 */
function parseSubagentIndexLines(raw: string): SubagentIndexEntry[] {
  const out: SubagentIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as SubagentIndexEntry);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * **W4a PR3 S6（2026-05-30）**：纯只读读取某父 session 的 `subagents.jsonl` 条目。
 *
 * 与 `SubagentIndexWriter#readEntries` 同款行级宽容解析，但**不构造 writer、不创建
 * 目录**——给 `check_agent_id` 这类「只查不写」路径用，避免只读查询产生 mkdir 写副作用
 * （PR3 review P2）。文件不存在 / 读失败 → 空数组。
 */
export async function readSubagentIndexEntries(
  parentSessionDir: string,
  parentSessionId: string,
): Promise<SubagentIndexEntry[]> {
  const filePath = path.join(parentSessionDir, parentSessionId, 'subagents.jsonl');
  try {
    if (!fs.existsSync(filePath)) return [];
    return parseSubagentIndexLines(await fs.promises.readFile(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * 父 session 维度的子 Agent 索引写入器。
 *
 * 落盘：`{parentSessionDir}/{parentSessionId}/subagents.jsonl`。
 *
 * 单实例对应一个父 session；构造时把目录创建好，每次 append 一行。失败不抛
 * （consoleWarn 兜底）—— 可观测性写入失败不能阻断主 fork 流程。
 */
export class SubagentIndexWriter {
  /**
   * 落盘文件绝对路径。失败兜底时为 null（构造时 mkdir 抛错 → no-op 模式）。
   *
   * 阶段 8 Review fix：原版本构造同步 `fs.mkdirSync` 抛错没有兜底，会让父
   * 拒绝 spawn 子 Agent。本类承诺"可观测性失败不阻断主流"，构造也得遵守。
   */
  private readonly filePath: string | null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly parentSessionDir: string,
    private readonly parentSessionId: string,
  ) {
    const dir = path.join(parentSessionDir, parentSessionId);
    let resolvedPath: string | null;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      resolvedPath = path.join(dir, 'subagents.jsonl');
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[subagent-index] mkdir failed for ${dir}; running in no-op mode: ${(err as Error)?.message ?? err}`,
        );
      } catch { /* ignore */ }
      resolvedPath = null;
    }
    this.filePath = resolvedPath;
  }

  getFilePath(): string | null {
    return this.filePath;
  }

  /**
   * **W2 resume（2026-05-30）**：读回本父 session 已落盘的所有索引条目。
   *
   * 行级宽容：单行 JSON.parse 失败 silent skip（与消费方 reader 同款），
   * 文件不存在 / 读失败返回空数组。用于 `getNextRunSeq` 计算 resume 序号，
   * 以及给折叠工具 `foldSubagentRuns` 喂数据。
   */
  async readEntries(): Promise<SubagentIndexEntry[]> {
    if (!this.filePath || !fs.existsSync(this.filePath)) return [];
    try {
      return parseSubagentIndexLines(await fs.promises.readFile(this.filePath, 'utf-8'));
    } catch {
      return [];
    }
  }

  /**
   * **W2 resume（2026-05-30）**：算出某 subSessionId 下一次 run 的序号。
   *
   * = 已落盘的 `started` 行数 + 1。首次 spawn → 1；第 N 次 resume → N+1。
   * 跨进程重启也正确（读的是持久化文件）。同一 childId 的 resume 是串行的
   * （只能 resume 已结束的子，运行中 resume 属 W3 interrupt），故无并发竞态。
   */
  async getNextRunSeq(subSessionId: string): Promise<number> {
    const entries = await this.readEntries();
    let started = 0;
    for (const e of entries) {
      if (e.phase === 'started' && e.subSessionId === subSessionId) started++;
    }
    return started + 1;
  }

  /** 子 Agent 起跑时 append 一行 `phase: 'started'`。 */
  async recordStart(input: Omit<SubagentIndexStartEntry, 'phase' | 'parentSessionId' | 'createdAtISO'>): Promise<void> {
    const entry: SubagentIndexStartEntry = {
      phase: 'started',
      parentSessionId: this.parentSessionId,
      ...input,
      task: truncate(input.task ?? ''),
      createdAtISO: new Date(input.createdAt).toISOString(),
    };
    await this._append(entry);
  }

  /** 子 Agent 收尾时 append 一行 `phase: 'ended'`。 */
  async recordEnd(input: Omit<SubagentIndexEndEntry, 'phase' | 'parentSessionId' | 'endedAtISO'>): Promise<void> {
    const entry: SubagentIndexEndEntry = {
      phase: 'ended',
      parentSessionId: this.parentSessionId,
      ...input,
      endedAtISO: new Date(input.endedAt).toISOString(),
      errorMessage: input.errorMessage ? truncate(input.errorMessage) : undefined,
    };
    await this._append(entry);
  }

  private async _append(entry: SubagentIndexEntry): Promise<void> {
    if (!this.filePath) {
      // no-op 模式：构造时 mkdir 已失败，写入永久跳过。warn 已经发过。
      return;
    }
    const filePath = this.filePath;
    const line = JSON.stringify(entry) + '\n';
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        await fs.promises.appendFile(filePath, line, { mode: 0o600 });
      } catch (err) {
        try {
          // eslint-disable-next-line no-console
          console.warn(
            `[subagent-index] append failed for ${this.parentSessionId}: ${(err as Error)?.message ?? err}`,
          );
        } catch { /* ignore */ }
      }
    });
    await this.writeQueue;
  }
}

// ─── W2 resume：按「最新 run」折叠 subagents.jsonl ────────────────────

/**
 * 一个 subSession 折叠后的状态快照（取**最新 run**，正确处理 resume 续跑）。
 *
 * 与 electron 端 `subagent-index-reader.ts::SubagentRunSnapshot` 的区别：那个
 * reader 走 last-write-wins 朴素折叠（resume 正常完成时碰巧也能折到最新 run，
 * 但 resume run 起跑后未结束 / 崩溃时会保留上一 run 的 `completed` 误判为非孤儿）。
 * 本工具是 **resume-aware 折叠的 SSoT**：按 (subSessionId, runSeq) 配对、取
 * `max(runSeq)`，让「最新 run started 但无 ended」如实折成 `running`（孤儿），
 * 不被旧 run 的终态污染。新消费方应采用本工具。
 */
export interface FoldedSubagentRun {
  subSessionId: string;
  childId: string;
  /** 最新 run 的序号（1 = 仅首次 spawn，2+ = 经历过 resume）。 */
  runSeq: number;
  /** 总共起跑过几次 run（含首次 spawn）。 */
  totalRuns: number;
  /** 最新 run 是否为 resume 续跑（runSeq > 1）。 */
  resumed: boolean;
  /**
   * 最新 run 的终态：completed / failed / cancelled = 有对应 ended 行；
   * `running` = 最新 run 只有 started 没有 ended（仍在跑或崩溃孤儿）。
   */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  task?: string;
  /** Group/Mission：子 Agent 角色名（started 行的 `role`）。缺省时消费方回落。 */
  role?: string;
  /** agent 工具 `description`（started 行的 `label`）→ 卡片标题，历史回放恢复用。 */
  label?: string;
  /** ：命中模板时的 template_id / 版本 / 显示名（started 行）。 */
  templateId?: string;
  templateVersion?: number;
  templateName?: string;
  model?: string;
  /** 最新 run 的起跑时刻。 */
  createdAt?: number;
  /** 最新 run 的结束时刻（孤儿则 undefined）。 */
  endedAt?: number;
  durationMs?: number;
  errorMessage?: string;
  parentToolCallId?: string;
}

function groupSubagentEntriesBySession(
  entries: SubagentIndexEntry[],
): Map<string, SubagentIndexEntry[]> {
  const bySession = new Map<string, SubagentIndexEntry[]>();
  for (const e of entries) {
    if (!e || typeof e.subSessionId !== 'string' || !e.subSessionId) continue;
    const arr = bySession.get(e.subSessionId) ?? [];
    arr.push(e);
    bySession.set(e.subSessionId, arr);
  }
  return bySession;
}

function indexSubagentRunEntries(group: SubagentIndexEntry[]): {
  startsBySeq: Map<number, SubagentIndexStartEntry>;
  endsBySeq: Map<number, SubagentIndexEndEntry>;
} {
  const startsBySeq = new Map<number, SubagentIndexStartEntry>();
  const endsBySeq = new Map<number, SubagentIndexEndEntry>();
  for (const e of group) {
    const seq = typeof e.runSeq === 'number' && e.runSeq > 0 ? e.runSeq : 1;
    if (e.phase === 'started') startsBySeq.set(seq, e);
    else if (e.phase === 'ended') endsBySeq.set(seq, e);
  }
  return { startsBySeq, endsBySeq };
}

function getLatestRunSeq(
  startsBySeq: Map<number, SubagentIndexStartEntry>,
  endsBySeq: Map<number, SubagentIndexEndEntry>,
): number | null {
  const allSeqs = new Set<number>([...startsBySeq.keys(), ...endsBySeq.keys()]);
  if (allSeqs.size === 0) return null;
  return Math.max(...allSeqs);
}

function buildFoldedIdentityFields(
  subSessionId: string,
  start: SubagentIndexStartEntry | undefined,
  end: SubagentIndexEndEntry | undefined,
  latestSeq: number,
  totalRuns: number,
): Pick<FoldedSubagentRun, 'subSessionId' | 'childId' | 'runSeq' | 'totalRuns' | 'resumed' | 'status'> {
  return {
    subSessionId,
    childId: start?.childId ?? end?.childId ?? '',
    runSeq: latestSeq,
    totalRuns,
    resumed: latestSeq > 1,
    status: end ? end.status : 'running',
  };
}

function buildFoldedStartFields(
  start: SubagentIndexStartEntry | undefined,
): Pick<FoldedSubagentRun,
  | 'task'
  | 'role'
  | 'label'
  | 'templateId'
  | 'templateVersion'
  | 'templateName'
  | 'model'
  | 'createdAt'
  | 'parentToolCallId'
> {
  return {
    task: start?.task,
    role: start?.role,
    label: start?.label,
    templateId: start?.templateId,
    templateVersion: start?.templateVersion,
    templateName: start?.templateName,
    model: start?.model,
    createdAt: start?.createdAt,
    parentToolCallId: start?.parentToolCallId,
  };
}

function buildFoldedEndFields(
  end: SubagentIndexEndEntry | undefined,
): Pick<FoldedSubagentRun, 'endedAt' | 'durationMs' | 'errorMessage'> {
  return {
    endedAt: end?.endedAt,
    durationMs: end?.durationMs,
    errorMessage: end?.errorMessage,
  };
}

function buildFoldedSubagentRun(
  subSessionId: string,
  startsBySeq: Map<number, SubagentIndexStartEntry>,
  endsBySeq: Map<number, SubagentIndexEndEntry>,
  latestSeq: number,
): FoldedSubagentRun {
  const start = startsBySeq.get(latestSeq);
  const end = endsBySeq.get(latestSeq);
  return {
    ...buildFoldedIdentityFields(subSessionId, start, end, latestSeq, startsBySeq.size),
    ...buildFoldedStartFields(start),
    ...buildFoldedEndFields(end),
  };
}

/**
 * **W2 resume（2026-05-30）**：把 append-only 的 `subagents.jsonl` 条目按
 * subSessionId 折叠成 `FoldedSubagentRun[]`，**取每个 subSession 的最新 run**。
 *
 * 折叠算法：
 *   1. 按 subSessionId 分组。
 *   2. 组内按 `runSeq`（缺省视为 1）把 started / ended 各自建索引；同序号重复
 *      （磁盘损坏）后写覆盖前写。
 *   3. 取 `max(runSeq)` 作为最新 run：started 行给 task/model/createdAt 等；
 *      ended 行给 status/endedAt/duration；**最新 run 无 ended → status='running'**
 *      （孤儿如实呈现，不被上一 run 的终态污染——这正是 resume 折叠的核心）。
 *
 * 结果按 createdAt 升序（与 electron reader 时序一致）。
 */
export function foldSubagentRuns(entries: SubagentIndexEntry[]): FoldedSubagentRun[] {
  const bySession = groupSubagentEntriesBySession(entries);

  const result: FoldedSubagentRun[] = [];
  for (const [subSessionId, group] of bySession) {
    const { startsBySeq, endsBySeq } = indexSubagentRunEntries(group);
    const latestSeq = getLatestRunSeq(startsBySeq, endsBySeq);
    if (latestSeq === null) continue;
    result.push(buildFoldedSubagentRun(subSessionId, startsBySeq, endsBySeq, latestSeq));
  }

  result.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return result;
}

// ─── W4b：崩溃残留子 Agent 收口（orphan reaper） ──────────────────────

/**
 * **W4b（2026-05-30）**：把崩溃 / 强杀留下的「孤儿」子 Agent run reconcile 成
 * `cancelled`，补齐缺失的 `ended` 行。
 *
 * ## 解决什么问题
 *
 * 进程崩溃 / 强杀时，正在跑的子 Agent 的 `subagents.jsonl` 只写了 `started` 没写
 * `ended`（forkQuery 的 finally 里 recordEnd 没跑完）。重启后这些 run 在
 * `foldSubagentRuns` 折叠下永远是 `status='running'`——但进程其实已死、子早就不在跑：
 *   - `check_agent_id` 报「运行中（无本会话内存记录）」——诚实但误导；
 *   - 历史 reader 把孤儿显示成 running。
 * 没有任何 reaper 把它们收口成终态。本函数补这个缺口。
 *
 * ## 关键不变式（防误杀正在跑的子，最重要）
 *
 * **本进程正在跑的子 Agent 也是 started-无-ended**（forkQuery 还没收尾，
 * `foldSubagentRuns` 也把它算成 `running`）。绝不能把它们当孤儿 cancel。
 *
 * 靠 `isStillActive(childId)` 区分：调用方传入「当前 session 的 SubagentManager
 * 内存态判活」（`(childId) => manager.has(childId)`）——
 *   - 本进程正在跑（含**后台子** / 排队子，都登记在 Manager）→ `has===true` → **跳过**；
 *   - 进程已死的真孤儿（Manager 里没有）→ `has===false` → reconcile 成 cancelled。
 * 正因为有这层内存态保护，reap 可以在 runtime 创建的任何时机安全调用，不会误杀
 * carry-forward 复用的后台子。
 *
 * ## 语义保证
 *
 * - **best-effort**：整体 try/catch + 每条单独 try/catch，任何失败不抛、不阻断
 *   runtime 创建（与本模块「可观测性写入失败不阻断主流」一致）。
 * - **幂等**：reconcile 后孤儿最新 run 已有 `ended(cancelled)`，再次跑时
 *   `foldSubagentRuns` 不再把它折成 `running`，故不在孤儿集 → 返回 0。
 * - **resume-aware**：只 reconcile 每个 subSession 的**最新 run**（`foldSubagentRuns`
 *   已按 (subSessionId, runSeq) 取 `max(runSeq)`）；旧 run 已 ended 的不受影响。
 * - **无孤儿零写副作用**：没找到需 reconcile 的孤儿时不构造 writer（不 mkdir）。
 *
 * @returns 实际 reconcile（补写 cancelled）的 run 数量。
 */
export async function reapOrphanedSubagentRuns(
  parentSessionDir: string,
  parentSessionId: string,
  isStillActive: (childId: string) => boolean,
): Promise<number> {
  try {
    const entries = await readSubagentIndexEntries(parentSessionDir, parentSessionId);
    if (entries.length === 0) return 0;

    const orphans = foldSubagentRuns(entries).filter(
      (run) => run.status === 'running' && !!run.childId && !isStillActive(run.childId),
    );
    if (orphans.length === 0) return 0;

    // 有真孤儿才构造 writer（构造会 mkdir；无孤儿时上面已 early-return 避免写副作用）。
    const writer = new SubagentIndexWriter(parentSessionDir, parentSessionId);
    const now = Date.now();
    let reconciled = 0;
    for (const run of orphans) {
      try {
        await writer.recordEnd({
          subSessionId: run.subSessionId,
          childId: run.childId,
          // 对齐被折叠的最新 run 序号——否则补的 ended 配不上 started，孤儿仍是 running。
          runSeq: run.runSeq,
          status: 'cancelled',
          endedAt: now,
          finalTextLength: 0,
          durationMs: run.createdAt ? Math.max(0, now - run.createdAt) : 0,
          errorMessage: '进程重启，运行中断（reaper 收口）',
        });
        reconciled++;
      } catch {
        // 单条补写失败不阻断其余（best-effort）。
      }
    }
    return reconciled;
  } catch {
    // 整体兜底：读盘 / 折叠 / 构造 writer 任一失败都不抛，不阻断 runtime 创建。
    return 0;
  }
}
