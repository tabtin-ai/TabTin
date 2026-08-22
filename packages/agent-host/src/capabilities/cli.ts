/**
 * CliCap —— tabtin CLI 命令的上下文注入。
 *
 * **目标**：TabTin 是 CLI-first 平台，能力都暴露成 `tabtin <命令>`（数百条）。让 Agent
 * 开局就知道有哪些命令域、以及跟本轮请求相关的命令细节，不必先跑 `tabtin commands` 探。
 * 命令通过 `run_terminal_command` 执行——本 Cap 只注入认知，不新增工具。
 *
 * **与 SkillsCap / McpCap 相同的两区机制**：
 *   - **静态段**（`<cli_commands>`，query 无关、跨轮稳定、可缓存）：只列一级命令
 *     （domain / group 根）。按预算截断（超出附 `tabtin commands --format json`）。
 *     写入 `state.__cliStaticIndex`，由 query.ts 注入 system 静态前缀。
 *   - **动态段**（`<relevant_cli>`，每轮随 query 变）：与 query BM25 相关的一级命令
 *     Top-N，前 N 条带完整描述，并引导通过 `--help` 继续发现。写入
 *     `state.__cliRelevant`，由 context-injector 注入。
 *
 * ：静态段与动态段对齐，不再把二级子命令名写入 system 索引。
 *
 * beforeRun 首算；#5503 beforeIteration 在 in_progress todo 推进（检索词变化）时重算，
 * 让相关命令随任务推进刷新。fetcher 抛错 / 无命令 → 本轮不注入（下一轮重试）。
 *
 * ：本 Cap 从 `@tabtin/agent-runtime` 的 capability/core 迁到共享宿主包
 * `@tabtin/agent-host`——agent-runtime 的 core 只留通用能力（filesystem / shell）。
 * 依赖的 `CapabilityBase` / `EngineHooks` / `SYSTEM_SECTION_NAMES` / 召回 helper 等经
 * `@tabtin/agent-runtime` 跨包 import（单向、合法）。
 */

import type { Tool, EngineHooks, RunHookContext } from '@tabtin/agent-runtime/engine';
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine';
import type { CapabilityCategory } from '@tabtin/agent-runtime/capability';
import {
  CapabilityBase,
  buildRecallQuery,
  collectDescribedKeys,
  blankSeenDescriptions,
} from '@tabtin/agent-runtime/capability';
import type { SemanticScorer } from '@tabtin/search';
import { RecallIndex } from '@tabtin/search';
import { MEDIA_IMAGE_CLI_INSTRUCTION } from './media-image.js';

// ─── Fetcher 契约 ────────────────────────────────────────────────────

/** 单条 tabtin CLI 命令的最小信息。 */
export interface CliCommandInfo {
  /** 完整命令 path，如 `browser open` / `agent db info`。 */
  name: string;
  description?: string;
  /** 一级命令的完整说明，用于动态召回时提供足够的能力边界。 */
  long?: string;
  /** 风险标注：''/'read' 只读，'write'/'high-risk-write' 写。用于动态段展示。 */
  risk?: string;
  /** 关键 flag 名（不含值），用于聚合子命令召回语义。 */
  flags?: string[];
  /**
   * pure group 入口命令标记（，对应 `tabtin commands` 的 `is_group`）。
   * 保留该元数据供宿主和后续命令树处理识别一级入口。
   */
  isGroup?: boolean;
}

/** `fetchCli` 返回结构。返回 `null` 表示拉取失败——本轮不注入（下一轮重试）。 */
export interface CliListing {
  commands: CliCommandInfo[];
}

/**
 * ：Cap 不再传 `organizationId`——它是 per-runtime 常量，已由 host
 * 装配期烘进 fetchCli 闭包（宿主按 OrganizationServicePolicy / media catalog
 * 做 prompt 门控，）。context 只保留非业务字段（`query`）。
 */
export type CliCapFetcher = (context: {
  query?: string;
}) => Promise<CliListing | null>;

export interface CliCapInit {
  /**
   * 拉取 tabtin CLI 命令树。由宿主层（Electron）注入，通常包装
   * `tabtin commands --format json` + `parseTabtinCommandsJson`（含缓存）。
   * 缺省则 CliCap 不做任何注入（hooks 返回 null）。
   */
  fetchCli?: CliCapFetcher;
  /** 模型 context window 大小（tokens），用于静态段命令名索引的预算（~1%）。 */
  contextWindowTokens?: number;
  /**
   * 语义打分器（ 双路召回），由宿主注入（`@tabtin/local-embedding`
   * 的 `createSemanticScorer`）。缺省时动态段为纯词法路，行为与注入前一致。
   */
  semanticScorer?: SemanticScorer;
}

// ─── 渲染常量 ────────────────────────────────────────────────────────

const STATIC_TAG_OPEN = '<cli_commands>';
const STATIC_TAG_CLOSE = '</cli_commands>';
const RELEVANT_TAG_OPEN = '<relevant_cli>';
const RELEVANT_TAG_CLOSE = '</relevant_cli>';

/** 静态段默认字符预算（与 skills 一致 / MCP 的 8000 ≈ 200k×1%×4）。 */
const DEFAULT_STATIC_BUDGET_CHARS = 8_000;

/** 动态相关命令最多展示条数。 */
const MAX_RELEVANT_COMMANDS = 8;
/** 其中最相关的前 N 条带描述，其余仅名字（与 skills 一致 / MCP TOP_DESC_COUNT）。 */
const RELEVANT_DESC_COUNT = 5;
/** 单条命令描述展示上限（字符）。 */
const CMD_DESC_CAP = 240;
const MEDIA_CMD_DESC_CAP = 1_800;

const STATIC_HEADER =
  '可用的 tabtin CLI 一级命令（用 run_terminal_command 执行，如 `tabtin <一级命令> --format json`）。\n'
  + '使用 `--format json` 获取机器可读结果时，禁止再接 `head` / `tail` 截断输出；需要缩小结果请用 CLI 的 `--jq` 或查询参数，完整大输出由 run_terminal_command 自动落盘。\n'
  + '这里只列出 `tabtin <一级命令>`；选定后先运行 `tabtin <一级命令> --help` 查看子命令、参数和示例，'
  + '也可用 `tabtin commands <domain> --format json` 查全，不要猜测下一级用法：';
const RELEVANT_HEADER =
  '与当前请求最相关的一级 CLI 命令（完整一级命令列表见上方 system prompt）。\n'
  + '这里只展示 `tabtin <一级命令>`；选定能力后，先运行 `tabtin <一级命令> --help` 查看具体子命令、参数和示例，不要猜测下一级用法：';
const RELEVANT_TABLE_HEADER = '| command | risk | description |\n| --- | --- | --- |';

function budgetCharsFromTokens(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_STATIC_BUDGET_CHARS;
  return Math.max(2_000, Math.floor(contextWindowTokens * 0.01 * 4));
}

/** 命令 path 的 domain = 第一个 token；sub = 其余（`agent db info` → domain `agent`, sub `db info`）。 */
function splitCommand(name: string): { domain: string; sub: string } {
  const trimmed = name.trim();
  const idx = trimmed.indexOf(' ');
  if (idx < 0) return { domain: trimmed, sub: '' };
  return { domain: trimmed.slice(0, idx), sub: trimmed.slice(idx + 1) };
}

function commandPath(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('tabtin ') ? trimmed.slice('tabtin '.length) : trimmed;
}

/** 折叠空白并截断到上限。 */
function clip(text: string, cap: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

/** Markdown 表格单元格：折叠空白 + 转义 `|`，空值给占位符（与 skills 一致 / MCP cell）。 */
function cell(value: string): string {
  const s = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return s || '—';
}

/**
 * 在给定字符预算内贪心塞一级命令行（`- name`，行间 `\n`），
 * 返回展示的名字 + 省略数量（至少展示 1 个）。
 */
function fitDomainLines(names: string[], budget: number): { shown: string[]; omitted: number } {
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    const lineLen = 2 + name.length; // `- ${name}`
    const cost = shown.length === 0 ? lineLen : lineLen + 1; // leading `\n`
    if (shown.length > 0 && used + cost > budget) break;
    shown.push(name);
    used += cost;
  }
  if (shown.length === 0 && names.length > 0) shown.push(names[0]);
  return { shown, omitted: names.length - shown.length };
}

/**
 * 从完整命令树提取一级入口（domain），保留首次出现顺序。
 * 子命令只用于发现 domain，不进入静态索引。
 */
function collectTopLevelDomains(commands: CliCommandInfo[]): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const cmd of commands) {
    const path = commandPath(cmd.name);
    if (!path) continue;
    const domain = splitCommand(path).domain;
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

/**
 * 静态段：只列一级命令（budget 截断）。无命令返回 null。
 * ：与动态段一致，不再列出二级子命令名。
 */
function renderStaticIndex(listing: CliListing, budgetChars: number): string | null {
  const domains = collectTopLevelDomains(
    listing.commands.filter((c) => c.name && c.name.trim()),
  );
  if (domains.length === 0) return null;

  const lines: string[] = [STATIC_HEADER];
  const nameBudget = Math.max(1, budgetChars - STATIC_HEADER.length);
  const { shown, omitted } = fitDomainLines(domains, nameBudget);
  for (const domain of shown) {
    lines.push(`- ${domain}`);
  }
  if (omitted > 0) {
    lines.push(`(+${omitted} 个一级命令，用 tabtin commands --format json 看全)`);
  }

  return lines.join('\n');
}

/** 双路召回索引里 CLI 命令候选集的 domain 名。 */
const RECALL_DOMAIN = 'cli';

interface TopLevelRecallEntry {
  command: CliCommandInfo;
  recallText: string;
}

const RECALL_ROOT_BUDGET = 800;
const RECALL_CHILD_NAMES_BUDGET = 1_200;
const RECALL_CHILD_FLAGS_BUDGET = 800;
const RECALL_CHILD_DESCRIPTIONS_BUDGET = 1_200;

function relevantDescriptionForCommand(cmd: CliCommandInfo): string {
  const description = cmd.long || cmd.description || '';
  if (cmd.name === 'media') {
    return [description, MEDIA_IMAGE_CLI_INSTRUCTION].filter(Boolean).join('\n');
  }
  return description;
}

/**
 * 召回结果固定为 `tabtin <一级命令>`，但搜索文本聚合该命令下全部子命令元数据，
 * 使具体任务词仍能命中正确能力入口。
 */
function buildTopLevelRecallEntries(commands: CliCommandInfo[]): TopLevelRecallEntry[] {
  const byDomain = new Map<string, CliCommandInfo[]>();
  for (const command of commands) {
    const path = commandPath(command.name);
    if (!path) continue;
    const domain = splitCommand(path).domain;
    const related = byDomain.get(domain) ?? [];
    related.push({ ...command, name: path });
    byDomain.set(domain, related);
  }

  return [...byDomain.entries()].map(([domain, related]) => {
    const root = related.find((command) => command.name === domain);
    const descriptions = related
      .map((command) => command.description?.trim())
      .filter((description): description is string => Boolean(description));
    const command: CliCommandInfo = root ?? {
      name: domain,
      description: clip(descriptions.join('；'), CMD_DESC_CAP),
      isGroup: true,
    };
    const rootText = clip(
      `${command.name} ${command.description ?? ''} ${command.long ?? ''}`,
      RECALL_ROOT_BUDGET,
    );
    const childNames = clip(
      related.map((child) => child.name).join(' '),
      RECALL_CHILD_NAMES_BUDGET,
    );
    const childFlags = clip(
      [...new Set(related.flatMap((child) => child.flags ?? []))].join(' '),
      RECALL_CHILD_FLAGS_BUDGET,
    );
    const childDescriptions = clip(
      descriptions.join(' '),
      RECALL_CHILD_DESCRIPTIONS_BUDGET,
    );
    const recallText = `${rootText} ${childNames} ${childFlags} ${childDescriptions}`;
    return { command, recallText };
  });
}

/**
 * 动态段：按词法 + 语义双路融合与 query 相关性取 Top-N 一级命令
 * （Markdown 表，前 N 条带完整描述）。无 query / 双路均无命中返回 null
 * （静态段已列全部一级命令）。语义路缺席时为纯词法路（相对阈值语义不变）。
 *
 * 候选集经 `RecallIndex` 全量同步（replaceAll）——文本变更的条目会触发向量
 * 后台预热，embedding 从「首次打分」提前到「清单刷新」。
 */
async function renderRelevantCommands(
  commands: CliCommandInfo[],
  query: string,
  recall: RecallIndex,
): Promise<string | null> {
  const q = query.trim();
  const entries = buildTopLevelRecallEntries(commands);
  if (!q || entries.length === 0) return null;

  recall.replaceAll(
    RECALL_DOMAIN,
    entries.map((entry) => ({
      id: entry.command.name,
      text: entry.recallText,
    })),
  );
  const results = await recall.query(RECALL_DOMAIN, q);
  const resultById = new Map(results.map((r) => [r.id, r]));

  const ranked = entries
    .map((entry) => ({ cmd: entry.command, result: resultById.get(entry.command.name) }))
    .filter((e): e is { cmd: CliCommandInfo; result: (typeof results)[number] } =>
      e.result?.relevant === true,
    )
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, MAX_RELEVANT_COMMANDS);

  if (ranked.length === 0) return null;

  const rows = ranked.map(({ cmd }, i) => {
    const risk = cmd.risk && cmd.risk.trim() ? cmd.risk : 'read';
    let descCell = '—';
    if (i < RELEVANT_DESC_COUNT) {
      const description = relevantDescriptionForCommand(cmd);
      if (description) {
        const descCap = cmd.name === 'media' ? MEDIA_CMD_DESC_CAP : CMD_DESC_CAP;
        descCell = cell(clip(description, descCap));
      }
    }
    return `| ${cell(`tabtin ${cmd.name}`)} | ${cell(risk)} | ${descCell} |`;
  });
  return `${RELEVANT_HEADER}\n${RELEVANT_TABLE_HEADER}\n${rows.join('\n')}`;
}

// ─── CliCap ──────────────────────────────────────────────────────────

/**
 * CliCap：tabtin CLI 命令上下文注入入口（两区）。`_recall` 是候选集缓存
 * （每轮 replaceAll 全量同步），clone 间共享同一实例是期望行为，无需 override。
 */
export class CliCap extends CapabilityBase {
  readonly type = 'cli';
  readonly category: CapabilityCategory = 'core';

  private readonly _fetch?: CliCapFetcher;
  private readonly _budgetChars: number;
  private readonly _recall: RecallIndex;

  constructor(init: CliCapInit = {}) {
    super();
    this._fetch = init.fetchCli;
    this._budgetChars = budgetCharsFromTokens(init.contextWindowTokens);
    this._recall = new RecallIndex({ scorer: init.semanticScorer });
  }

  /** CliCap 不暴露 FC 工具——命令通过 run_terminal_command 执行。 */
  tools(): Tool[] {
    return [];
  }

  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  //  批次 10：注入产物存实例字段（原 `state.__cliStaticIndex` /
  // `__cliRelevant` 黑板字段）——beforeRun 计算一次、beforeModel 每轮注入。
  private _staticIndexBlock: string | undefined;
  private _relevantBlock: string | undefined;
  /** ：上次算召回块所用的检索词（用户原话 + in_progress todo），beforeIteration 门控。 */
  private _lastRecallQuery: string | undefined;

  /** context-injector 的 relevant 块读取口（原 `state.__cliRelevant`）。 */
  getRelevantBlock(): string | undefined {
    return this._relevantBlock;
  }

  clone(): CliCap {
    const cloned = super.clone() as CliCap;
    cloned._staticIndexBlock = undefined;
    cloned._relevantBlock = undefined;
    cloned._lastRecallQuery = undefined;
    return cloned;
  }

  hooks(): EngineHooks | null {
    if (!this._fetch) return null;
    const fetchCli = this._fetch;
    const budgetChars = this._budgetChars;
    const recall = this._recall;

    // ：抽 refresh —— beforeRun 首算 + beforeIteration 随 in_progress todo 推进重算。
    const refresh = async (
      state: RunHookContext['state'],
      query: string,
    ): Promise<void> => {
        this._staticIndexBlock = undefined;
        this._relevantBlock = undefined;

        let listing: CliListing | null;
        try {
          // ：organizationId 已由 host 烘进闭包，Cap 只传 query。
          listing = await fetchCli({ query });
        } catch {
          return;
        }
        if (!listing) return;

        const staticBody = renderStaticIndex(listing, budgetChars);
        if (!staticBody) return;

        this._staticIndexBlock = `${STATIC_TAG_OPEN}\n${staticBody}\n${STATIC_TAG_CLOSE}`;

        const relevantBody = await renderRelevantCommands(listing.commands, query, recall);
        if (relevantBody) {
          const block = `${RELEVANT_TAG_OPEN}\n${relevantBody}\n${RELEVANT_TAG_CLOSE}`;
          // 描述已在上文（当轮 live 消息）出现过的命令，描述列替换成「（见上文）」去重。
          const seen = collectDescribedKeys(state.messages, RELEVANT_TAG_OPEN, RELEVANT_TAG_CLOSE);
          this._relevantBlock = blankSeenDescriptions(block, seen);
        }
    };

    return {
      // ：与 Skills/MCP beforeRun 互不依赖，composeHooks 可并行调度。
      beforeRunParallel: true,
      beforeRun: async (runCtx: RunHookContext) => {
        const query = buildRecallQuery(runCtx.state.messages);
        this._lastRecallQuery = query;
        await refresh(runCtx.state, query);
      },
      beforeIteration: async (iterCtx) => {
        const query = buildRecallQuery(iterCtx.state.messages);
        if (query === this._lastRecallQuery) return;
        this._lastRecallQuery = query;
        await refresh(iterCtx.state, query);
      },
      beforeModel: async (ctx) => {
        if (!this._staticIndexBlock) return;
        ctx.appendSystemSection(
          SYSTEM_SECTION_NAMES.cli_commands,
          this._staticIndexBlock,
          'cli-cap',
          { placement: 'static' },
        );
      },
    };
  }
}
