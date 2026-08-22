/**
 * McpCap —— 已挂载 MCP 能力的上下文注入。
 *
 * **目标**：让 Agent 开局就知道当前 Space 挂了哪些 MCP server、各有哪些工具，以及跟本轮
 * 请求相关的工具细节，不必先跑 `tabtin mcp list-servers` / `list-tools` 懒发现。真正调用
 * 仍走 host 侧的 `mcp_call_tool`——本 Cap 只注入认知，不新增工具。
 *
 * **与 SkillsCap 相同的两区机制**：
 *   - **静态段**（`<mcp_servers>`，query 无关、跨轮稳定、可缓存）：已挂载 server + 工具名
 *     索引。server 全列；工具名按预算截断（超出附 `tabtin mcp list-tools` 查询方法）。
 *     写入 `state.__mcpStaticIndex`，由 query.ts 注入 system 静态前缀（boundary 之前）。
 *   - **动态段**（`<relevant_mcp>`，每轮随 query 变）：与本轮 query BM25 相关的工具 Top-N
 *     带描述。写入 `state.__mcpRelevant`，由 context-injector 拼进当轮 `<context>`。
 *
 * beforeRun 首算；#5503 beforeIteration 在 in_progress todo 推进（检索词变化）时重算，
 * 让相关工具随任务推进刷新。fetcher 抛错 / 无挂载 → 本轮不注入（下一轮重试），
 * 与 SkillsCap 两区路径一致。
 *
 * ：本 Cap 从 `@tabtin/agent-runtime` 的 capability/core 迁到共享宿主包
 * `@tabtin/agent-host`；依赖的 runtime 契约与召回 helper 经 `@tabtin/agent-runtime`
 * 跨包 import（单向、合法）。
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

// ─── Fetcher 契约 ────────────────────────────────────────────────────

/** 单个已挂载 MCP server 的最小信息。 */
export interface McpServerInfo {
  serverName: string;
  /** 来源标签（如 "Cursor" / "Claude Desktop" / 手动添加），用于展示。 */
  sourceLabel?: string;
}

/** 单个 MCP 工具的最小信息（用于相关性排序 + 展示）。 */
export interface McpToolInfo {
  serverName: string;
  name: string;
  description?: string;
}

/**
 * `fetchMcp` 返回结构。
 * - `servers`：当前 Space 已挂载的 MCP server（本地读取，宿主应保证快）。
 * - `tools`：各 server 的工具汇总（live 调用，宿主应缓存 + 抗抖动）。
 *
 * 返回 `null` 表示「本次拉取失败」——McpCap 本轮不注入（下一轮重试）。
 */
export interface McpListing {
  servers: McpServerInfo[];
  tools: McpToolInfo[];
}

/**
 * ：Cap 不再传 `spaceId`——它是 per-runtime 常量，已由 host 装配期
 * 烘进 fetchMcp 闭包。context 只保留非业务字段（`query`）。
 */
export type McpCapFetcher = (context: {
  query?: string;
}) => Promise<McpListing | null>;

export interface McpCapInit {
  /**
   * 拉取当前 Space 已挂载 MCP server + 工具。由宿主层（Electron）注入，通常包装
   * `LocalMcpService.listAttachedServers` + `listAttachedTools`（含缓存 / TTL / 抗抖动）。
   * 缺省则 McpCap 不做任何注入（hooks 返回 null）。
   */
  fetchMcp?: McpCapFetcher;
  /**
   * 模型 context window 大小（tokens），用于静态段工具名索引的预算（~1%）。
   * 缺省用 {@link DEFAULT_STATIC_BUDGET_CHARS}。
   */
  contextWindowTokens?: number;
  /**
   * 语义打分器（ 双路召回），由宿主注入（`@tabtin/local-embedding`
   * 的 `createSemanticScorer`）。缺省时动态段为纯词法路，行为与注入前一致。
   */
  semanticScorer?: SemanticScorer;
}

// ─── 渲染常量 ────────────────────────────────────────────────────────

const STATIC_TAG_OPEN = '<mcp_servers>';
const STATIC_TAG_CLOSE = '</mcp_servers>';
const RELEVANT_TAG_OPEN = '<relevant_mcp>';
const RELEVANT_TAG_CLOSE = '</relevant_mcp>';

/** 静态段默认字符预算（与 SkillsCap 一致的 8000 ≈ 200k×1%×4）。 */
const DEFAULT_STATIC_BUDGET_CHARS = 8_000;
/** 每个 server 至少给这么多字符列工具名（保证即便预算紧张也能看到几个工具）。 */
const MIN_PER_SERVER_CHARS = 80;

/** 动态相关工具最多展示条数。 */
const MAX_RELEVANT_TOOLS = 8;
/** 其中最相关的前 N 条带完整描述，其余仅名字（与 skills 动态段 TOP_DESC_COUNT 一致）。 */
const RELEVANT_DESC_COUNT = 5;
/** 单条工具描述展示上限（字符）。 */
const TOOL_DESC_CAP = 160;

const STATIC_HEADER =
  '已挂载的 MCP server 及其工具（用 mcp_call_tool 调用；工具名省略部分用 `tabtin mcp list-tools --server-name <name> --format json` 查全）：';
// 动态段格式与 skills `<relevant_skills>` 一致：英文说明句 + Markdown 表（前 N 行带描述，其余 —）。
const RELEVANT_HEADER =
  'Most relevant MCP tools for the current request (full tool list is in the system prompt above):';
const RELEVANT_TABLE_HEADER = '| tool | server | description |\n| --- | --- | --- |';

function budgetCharsFromTokens(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_STATIC_BUDGET_CHARS;
  // ~1% context window，按 1 token ≈ 4 chars 估算；给个下限避免超小模型退化到 0。
  return Math.max(2_000, Math.floor(contextWindowTokens * 0.01 * 4));
}

/** 折叠空白并截断到上限。 */
function clip(text: string, cap: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

/** Markdown 表格单元格：折叠空白 + 转义 `|`，空值给占位符（与 skills cell 一致）。 */
function cell(value: string): string {
  const s = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return s || '—';
}

/** 在给定字符预算内贪心塞工具名，返回展示的名字 + 省略数量（至少展示 1 个）。 */
function fitToolNames(names: string[], budget: number): { shown: string[]; omitted: number } {
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    const cost = shown.length === 0 ? name.length : name.length + 2 // ', '
    if (shown.length > 0 && used + cost > budget) break;
    shown.push(name);
    used += cost;
  }
  if (shown.length === 0 && names.length > 0) shown.push(names[0]); // 至少给 1 个
  return { shown, omitted: names.length - shown.length };
}

/**
 * 静态段：server 全列 + 工具名（等分预算截断）。无挂载 server 返回 null。
 */
function renderStaticIndex(listing: McpListing, budgetChars: number): string | null {
  const servers = listing.servers.filter((s) => s.serverName);
  if (servers.length === 0) return null;

  const toolsByServer = new Map<string, string[]>();
  for (const tool of listing.tools) {
    if (!tool.name || !tool.serverName) continue;
    const list = toolsByServer.get(tool.serverName) ?? [];
    list.push(tool.name);
    toolsByServer.set(tool.serverName, list);
  }

  const lines: string[] = [STATIC_HEADER];
  // server 全列优先：工具名预算在 server 间等分，保证每个 server 都能出现。
  const perServer = Math.max(
    MIN_PER_SERVER_CHARS,
    Math.floor((budgetChars - STATIC_HEADER.length) / servers.length),
  );

  for (const server of servers) {
    const label = server.sourceLabel ? `（来自 ${server.sourceLabel}）` : '';
    const names = toolsByServer.get(server.serverName) ?? [];
    if (names.length === 0) {
      lines.push(`- ${server.serverName}${label}: (无工具)`);
      continue;
    }
    const { shown, omitted } = fitToolNames(names, perServer);
    let toolsStr = shown.join(', ');
    if (omitted > 0) {
      toolsStr += ` (+${omitted} 个，用 tabtin mcp list-tools --server-name ${server.serverName} 看全)`;
    }
    lines.push(`- ${server.serverName}${label}: ${toolsStr}`);
  }

  return lines.join('\n');
}

/** 双路召回索引里 MCP 工具候选集的 domain 名。 */
const RECALL_DOMAIN = 'mcp';

/**
 * 动态段：按词法 + 语义双路融合与 query 相关性取 Top-N 工具（带描述）。
 * 无 query / 双路均无命中返回 null（静态段已列全部工具名，动态段只在有信号时补细节）。
 * 语义路缺席时为纯词法路（相对阈值语义不变）。
 *
 * 候选集经 `RecallIndex` 全量同步（replaceAll）——文本变更的条目会触发向量
 * 后台预热，embedding 从「首次打分」提前到「清单刷新」。
 */
async function renderRelevantTools(
  tools: McpToolInfo[],
  query: string,
  recall: RecallIndex,
): Promise<string | null> {
  const q = query.trim();
  const valid = tools.filter((t) => t.name && t.serverName);
  if (!q || valid.length === 0) return null;

  recall.replaceAll(
    RECALL_DOMAIN,
    valid.map((t) => ({
      id: `${t.serverName}::${t.name}`,
      text: `${t.name} ${t.description ?? ''}`,
    })),
  );
  const results = await recall.query(RECALL_DOMAIN, q);
  const resultById = new Map(results.map((r) => [r.id, r]));

  const ranked = valid
    .map((t) => ({ tool: t, result: resultById.get(`${t.serverName}::${t.name}`) }))
    .filter((e): e is { tool: McpToolInfo; result: (typeof results)[number] } =>
      e.result?.relevant === true,
    )
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, MAX_RELEVANT_TOOLS);

  if (ranked.length === 0) return null;

  // 与 skills 动态段一致：Markdown 表，前 RELEVANT_DESC_COUNT 行带描述，其余描述列为 —
  // （工具名在静态段 <mcp_servers> 已有）。
  const rows = ranked.map(({ tool }, i) => {
    const desc =
      i < RELEVANT_DESC_COUNT && tool.description ? cell(clip(tool.description, TOOL_DESC_CAP)) : '—';
    return `| ${cell(tool.name)} | ${cell(tool.serverName)} | ${desc} |`;
  });
  return `${RELEVANT_HEADER}\n${RELEVANT_TABLE_HEADER}\n${rows.join('\n')}`;
}

// ─── McpCap ──────────────────────────────────────────────────────────

/**
 * McpCap：已挂载 MCP 上下文注入入口（两区）。
 *
 * `_recall` 是候选集缓存（每轮 replaceAll 全量同步），clone 间共享同一实例
 * 是期望行为，无需 override clone。
 */
export class McpCap extends CapabilityBase {
  readonly type = 'mcp';
  readonly category: CapabilityCategory = 'core';

  private readonly _fetch?: McpCapFetcher;
  private readonly _budgetChars: number;
  private readonly _recall: RecallIndex;

  constructor(init: McpCapInit = {}) {
    super();
    this._fetch = init.fetchMcp;
    this._budgetChars = budgetCharsFromTokens(init.contextWindowTokens);
    this._recall = new RecallIndex({ scorer: init.semanticScorer });
  }

  /** McpCap 不暴露 FC 工具——`mcp_call_tool` 由宿主 ToolProvider 提供。 */
  tools(): Tool[] {
    return [];
  }

  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  //  批次 10：注入产物存实例字段（原 `state.__mcpStaticIndex` /
  // `__mcpRelevant` 黑板字段）——beforeRun 计算一次、beforeModel 每轮注入。
  private _staticIndexBlock: string | undefined;
  private _relevantBlock: string | undefined;
  /** ：上次算召回块所用的检索词（用户原话 + in_progress todo），beforeIteration 门控。 */
  private _lastRecallQuery: string | undefined;

  /** context-injector 的 relevant 块读取口（原 `state.__mcpRelevant`）。 */
  getRelevantBlock(): string | undefined {
    return this._relevantBlock;
  }

  clone(): McpCap {
    const cloned = super.clone() as McpCap;
    cloned._staticIndexBlock = undefined;
    cloned._relevantBlock = undefined;
    cloned._lastRecallQuery = undefined;
    return cloned;
  }

  hooks(): EngineHooks | null {
    if (!this._fetch) return null;
    const fetchMcp = this._fetch;
    const budgetChars = this._budgetChars;
    const recall = this._recall;

    // ：抽 refresh —— beforeRun 首算 + beforeIteration 随 in_progress todo 推进重算。
    const refresh = async (
      state: RunHookContext['state'],
      query: string,
    ): Promise<void> => {
        this._staticIndexBlock = undefined;
        this._relevantBlock = undefined;

        let listing: McpListing | null;
        try {
          // ：spaceId 已由 host 烘进闭包，Cap 只传 query。
          listing = await fetchMcp({ query });
        } catch {
          // 拉取抛错：本 run 不注入（产物已清空，下一 run 重试）。
          return;
        }
        if (!listing) return;

        const staticBody = renderStaticIndex(listing, budgetChars);
        if (!staticBody) return; // 无挂载 server

        this._staticIndexBlock = `${STATIC_TAG_OPEN}\n${staticBody}\n${STATIC_TAG_CLOSE}`;

        const relevantBody = await renderRelevantTools(listing.tools, query, recall);
        if (relevantBody) {
          const block = `${RELEVANT_TAG_OPEN}\n${relevantBody}\n${RELEVANT_TAG_CLOSE}`;
          // 描述已在上文（当轮 live 消息）出现过的工具，描述列替换成「（见上文）」去重。
          const seen = collectDescribedKeys(state.messages, RELEVANT_TAG_OPEN, RELEVANT_TAG_CLOSE);
          this._relevantBlock = blankSeenDescriptions(block, seen);
        }
    };

    return {
      // ：与 Skills/CLI beforeRun 互不依赖，composeHooks 可并行调度。
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
          SYSTEM_SECTION_NAMES.mcp_servers,
          this._staticIndexBlock,
          'mcp-cap',
          { placement: 'static' },
        );
      },
    };
  }
}
