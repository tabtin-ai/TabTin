/**
 * 通用双路召回索引 —— 按 domain 分域的候选集 CRUD + 相关性检索。
 *
 * **为什么存在**：skill / CLI / MCP 三个消费点原先各自拼 `RankItem[]` 后直接调
 * `rankDualPath`，候选集是「每轮临时构造、用完即弃」的——没有统一的增删改查
 * 入口，语义向量也只能等首次打分时现算（首轮超时缺席）。本类把「候选集管理」
 * 收成一个业务无关的库：
 *
 * - **domain 分域**：一个实例可承载多个互不干扰的候选域（'skills' / 'cli' /
 *   'mcp'，后续 app、文档等发现场景直接加新 domain，不改库）。
 * - **CRUD 接口**（`RecallStore`）：`upsert` 增/改、`remove` 删、`replaceAll`
 *   全量同步（清单快照场景）、`get` / `list` 查。
 * - **检索**（`query`）：词法 BM25 + 语义双路 RRF 融合（复用 `rankDualPath`，
 *   兜底契约不变：scorer 缺席/未就绪/超时都退纯词法路）。
 * - **预热**：条目新增或文本变更时调 `scorer.warm()` 后台预计算向量——
 *   embedding 时机从「首次打分」提前到「清单刷新」，消除首轮语义路缺席。
 *
 * 纯内存、零运行时依赖；候选集几十到几百条量级，全量线性打分即可。
 * 语义能力仍由宿主经 `SemanticScorer` 注入，本类不做任何推理。
 */

import type { RankItem } from './bm25.js';
import type { DualRankOptions, DualRankResult, SemanticScorer } from './dual-recall.js';
import { rankDualPath } from './dual-recall.js';

/** 候选条目：稳定 id + 参与打分的文本。 */
export type RecallItem = RankItem;

/**
 * RecallIndex 期望的打分器：在 `rankDualPath` 的 `score` 契约之上可选支持
 * `warm`（候选向量预计算）。条目新增/文本变更时调用，把 embedding 计算从
 * 「首次打分」提前到「清单刷新」，消除首轮打分超时导致的语义路缺席。
 * 实现应为后台 fire-and-forget（内部吞错），不阻塞调用方。
 */
export interface WarmableSemanticScorer extends SemanticScorer {
  warm?(items: readonly RecallItem[]): void;
}

/** 检索命中：分数 + 是否过相关性门槛（语义/词法任一路命中）。 */
export type RecallHit = DualRankResult;

export type RecallQueryOptions = DualRankOptions;

/**
 * 按 domain 分域的候选集增删改查 + 检索契约。
 * 默认实现为进程内存版 `RecallIndex`；后续如需落盘 / 远端索引，实现同一接口替换。
 */
export interface RecallStore {
  /** 增/改：按 id 插入或覆盖。 */
  upsert(domain: string, items: readonly RecallItem[]): void;
  /** 删：按 id 移除，不存在的 id 忽略。 */
  remove(domain: string, ids: readonly string[]): void;
  /** 全量同步：用快照替换整个 domain（清单刷新场景，等价 clear + upsert）。 */
  replaceAll(domain: string, items: readonly RecallItem[]): void;
  /** 查单条。 */
  get(domain: string, id: string): RecallItem | undefined;
  /** 查全部（插入序）。 */
  list(domain: string): RecallItem[];
  /** 清空一个 domain。 */
  clear(domain: string): void;
  /** 相关性检索：对 domain 内全部候选打分，按插入序返回（排序/截断由调用方做）。 */
  query(
    domain: string,
    queryText: string,
    options?: RecallQueryOptions,
  ): Promise<RecallHit[]>;
}

export interface RecallIndexOptions {
  /** 语义打分器（宿主注入）。缺省时 query 走纯词法路，warm 为空操作。 */
  scorer?: WarmableSemanticScorer;
}

export class RecallIndex implements RecallStore {
  private readonly scorer?: WarmableSemanticScorer;
  /** domain → (id → item)。Map 迭代序即插入序。 */
  private readonly domains = new Map<string, Map<string, RecallItem>>();

  constructor(options: RecallIndexOptions = {}) {
    this.scorer = options.scorer;
  }

  upsert(domain: string, items: readonly RecallItem[]): void {
    const store = this.domainStore(domain);
    const changed: RecallItem[] = [];
    for (const item of items) {
      const prev = store.get(item.id);
      if (!prev || prev.text !== item.text) changed.push(item);
      store.set(item.id, item);
    }
    this.warmChanged(changed);
  }

  remove(domain: string, ids: readonly string[]): void {
    const store = this.domains.get(domain);
    if (!store) return;
    for (const id of ids) store.delete(id);
  }

  replaceAll(domain: string, items: readonly RecallItem[]): void {
    const prev = this.domains.get(domain);
    const next = new Map<string, RecallItem>();
    const changed: RecallItem[] = [];
    for (const item of items) {
      next.set(item.id, item);
      const old = prev?.get(item.id);
      if (!old || old.text !== item.text) changed.push(item);
    }
    this.domains.set(domain, next);
    this.warmChanged(changed);
  }

  get(domain: string, id: string): RecallItem | undefined {
    return this.domains.get(domain)?.get(id);
  }

  list(domain: string): RecallItem[] {
    const store = this.domains.get(domain);
    return store ? [...store.values()] : [];
  }

  clear(domain: string): void {
    this.domains.delete(domain);
  }

  async query(
    domain: string,
    queryText: string,
    options?: RecallQueryOptions,
  ): Promise<RecallHit[]> {
    return rankDualPath(this.list(domain), queryText, this.scorer, options);
  }

  private domainStore(domain: string): Map<string, RecallItem> {
    let store = this.domains.get(domain);
    if (!store) {
      store = new Map();
      this.domains.set(domain, store);
    }
    return store;
  }

  /** 新增/变更条目后台预热向量。scorer 无 warm 能力时为空操作。 */
  private warmChanged(changed: readonly RecallItem[]): void {
    if (changed.length === 0) return;
    this.scorer?.warm?.(changed);
  }
}
