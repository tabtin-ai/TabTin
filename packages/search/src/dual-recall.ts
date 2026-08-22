/**
 * 词法 + 语义双路召回融合 —— 。
 *
 * 三路动态段（`<relevant_skills>` / `<relevant_mcp>` / `<relevant_cli>`）共用的
 * 打分入口。在既有 BM25 词法路之上叠加一条语义路（宿主注入的
 * `SemanticScorer`，本地 ONNX 模型实现在 `@tabtin/local-embedding`），两路结果
 * 用倒数排名融合（RRF）合并——语义路能召回「词面零重合但语义相关」的候选，
 * 这是本模块存在的意义。
 *
 * 兜底契约（方案文档明确标注的可用性设计，非降级修复）：
 * `scorer` 未注入、返回 null（模型未就绪）、抛错、超时四种情况下，返回结果与
 * 纯词法路完全一致（分数即 BM25 分、`relevant` 即相对阈值判定），调用方行为
 * 零回归。Daemon 无语义服务、首次启动模型未下载完都会走到这条路。
 *
 * agent-runtime 是纯 TS 库：本文件不做任何推理，只消费注入的打分回调。
 */

import type { RankItem, RankResult } from './bm25.js';
import { RELEVANCE_RELATIVE_THRESHOLD, rankByRelevance } from './bm25.js';
import {
  computeDecoyBaselines,
  decoyCutoffForText,
  decoyRankItems,
  isDecoyId,
} from './decoys.js';

/**
 * 宿主注入的语义打分能力（结构类型，与 `@tabtin/local-embedding` 的
 * `createSemanticScorer` 返回值对齐，故意不产生包依赖）。
 *
 * 返回 null 表示本轮语义路整体不可用（模型未就绪 / 查询推理失败）；
 * 返回数组时允许缺条目（个别候选向量缺失），缺失条目视为语义路未命中。
 */
export interface SemanticScorer {
  score(
    items: readonly RankItem[],
    query: string,
  ): Promise<RankResult[] | null>;
}

export interface DualRankResult {
  id: string;
  /**
   * 排序用分数。双路生效时为 RRF 融合分（量纲 ~1/RRF_K），词法单路时为
   * BM25 原始分。两种模式量纲不同，但消费方只做当轮内相对比较（排序 +
   * 相对加分），不跨轮比较绝对值，所以安全。
   */
  score: number;
  /** 是否通过相关性门槛（词法或语义任一路命中即 true），决定进入动态段的资格。 */
  relevant: boolean;
}

/**
 * 语义路 z-score 门槛：候选相似度须高出当轮均值 1.2 个标准差。
 *
 * live 校准（e5-small，真实查询）发现绝对余弦阈值不可行：中文查询 × 中文
 * 候选时无关对基线在 0.83~0.86（0.8 阈值等于不设防），中文查询 × 英文候选
 * （跨语言，大量 skill/MCP 描述是英文）时真命中只有 0.80~0.83（阈值抬高又
 * 全漏）。两种场景没有共同的绝对分界线，但真命中始终是当轮分布内的离群
 * 高分——门槛用分布相对量。
 */
export const SEMANTIC_ZSCORE_THRESHOLD = 1.2;

/**
 * 语义路对当轮均值的最小绝对边际。与 z-score 双条件取更严者：**同质无关
 * 候选池**（如全库 tushare 行情工具遇到「帮我截图」）分布极窄（std≈0.009），
 * 纯 z-score 会把 1.6% 的相似度波动当离群放进来；真命中对均值的边际稳定在
 * 0.026+，无关波动在 0.017 以下，0.02 分界干净。扩展校准集（22 期望项 ×
 * 15 查询 × 混合/同质/纯英文三种池）上双条件命中 15/22、噪音 5 条，均优于
 * 单 z-score 1.5σ（11/22、7 条）。
 */
export const SEMANTIC_MEAN_MARGIN = 0.02;

/**
 * 语义路相似度保底下限。z-score 与边际都是分布相对量，当轮全员低分时也会
 * 放进纯噪音（如「现在几点了」对全部候选都不相关），用绝对下限兜住。
 * 取 0.78：低于跨语言真命中带（0.80+），高于纯无关对的典型分布。
 */
export const SEMANTIC_SIMILARITY_FLOOR = 0.78;

/**
 * z-score 门槛生效所需的最小候选数。样本太少时均值/标准差没有统计意义
 * （两条候选一高一低，高的那条永远过不了门槛），退化为仅按绝对保底过滤；
 * 反正 `SEMANTIC_TOP_CAP` 已经限制了小候选池的注入规模。
 */
export const SEMANTIC_ZSCORE_MIN_CANDIDATES = 8;

/**
 * RRF 融合常数：融合分 = Σ 1/(RRF_K + 该路排名)。60 是信息检索文献中的
 * 标准取值，对头部排名差异敏感、对尾部不敏感。
 */
export const RRF_K = 60;

/** 语义路进入融合的候选数上限——防止语义路把并集撑大、稀释词法强命中。 */
export const SEMANTIC_TOP_CAP = 8;

/**
 * 语义打分超时（毫秒）。查询向量推理正常 10-30ms；超过此值说明模型异常或
 * 首次加载抖动，本轮放弃语义路，不拖慢对话关键路径。
 */
export const SEMANTIC_SCORE_TIMEOUT_MS = 300;

export interface DualRankOptions {
  timeoutMs?: number;
}

/** 词法路存活集合：score > 0 且 >= 当轮最高分 × 相对阈值（沿用既有语义）。 */
function lexicalSurvivors(scores: RankResult[]): RankResult[] {
  const maxScore = scores.reduce((m, r) => Math.max(m, r.score), 0);
  if (maxScore <= 0) return [];
  const cutoff = maxScore * RELEVANCE_RELATIVE_THRESHOLD;
  return scores
    .filter((r) => r.score > 0 && r.score >= cutoff)
    .sort((a, b) => b.score - a.score);
}

/** 语义路存活集合：诱饵基线 + z-score + 绝对保底 + Top 上限。 */
function semanticSurvivors(
  scores: RankResult[],
  query: string,
  itemTextById: ReadonlyMap<string, string>,
  decoyBaselines: ReturnType<typeof computeDecoyBaselines>,
): RankResult[] {
  if (scores.length === 0) return [];

  let poolCutoff = SEMANTIC_SIMILARITY_FLOOR;
  if (scores.length >= SEMANTIC_ZSCORE_MIN_CANDIDATES) {
    const mean = scores.reduce((sum, r) => sum + r.score, 0) / scores.length;
    const std = Math.sqrt(
      scores.reduce((sum, r) => sum + (r.score - mean) ** 2, 0) / scores.length,
    );
    poolCutoff = Math.max(
      poolCutoff,
      mean + SEMANTIC_ZSCORE_THRESHOLD * std,
      mean + SEMANTIC_MEAN_MARGIN,
    );
  }

  return scores
    .filter((r) => {
      const text = itemTextById.get(r.id) ?? '';
      const cutoff = Math.max(poolCutoff, decoyCutoffForText(text, decoyBaselines, query));
      return r.score >= cutoff;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, SEMANTIC_TOP_CAP);
}

async function scoreWithTimeout(
  scorer: SemanticScorer,
  items: readonly RankItem[],
  query: string,
  timeoutMs: number,
): Promise<RankResult[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([scorer.score(items, query), timeout]);
  } catch {
    return null; // 语义路异常按不可用处理，兜底契约见文件头
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 双路融合打分。**保持输入顺序**返回全部条目（与 `rankByRelevance` 一致），
 * 过滤（`relevant`）、排序（`score`）、截断由调用方完成——skill 路还要叠加
 * focusedApp 加分，融合层不掺业务信号。
 */
export async function rankDualPath(
  items: readonly RankItem[],
  query: string,
  scorer?: SemanticScorer,
  options?: DualRankOptions,
): Promise<DualRankResult[]> {
  const lexScores = rankByRelevance(items, query);
  const lexSurvivorRanks = new Map(
    lexicalSurvivors(lexScores).map((r, index) => [r.id, index + 1]),
  );

  const itemTextById = new Map(items.map((it) => [it.id, it.text]));
  const decoys = decoyRankItems();

  const semScores =
    scorer && query.trim() && items.length > 0
      ? await scoreWithTimeout(
          scorer,
          [...items, ...decoys],
          query,
          options?.timeoutMs ?? SEMANTIC_SCORE_TIMEOUT_MS,
        )
      : null;

  // 语义路不可用 → 纯词法路，结果与现状逐条一致。
  if (semScores === null) {
    return lexScores.map((r) => ({
      id: r.id,
      score: r.score,
      relevant: lexSurvivorRanks.has(r.id),
    }));
  }

  const decoyBaselines = computeDecoyBaselines(
    semScores.filter((r) => isDecoyId(r.id)),
  );
  const candidateSemScores = semScores.filter((r) => !isDecoyId(r.id));

  const semSurvivorRanks = new Map(
    semanticSurvivors(candidateSemScores, query, itemTextById, decoyBaselines).map(
      (r, index) => [r.id, index + 1],
    ),
  );

  return lexScores.map((r) => {
    const lexRank = lexSurvivorRanks.get(r.id);
    const semRank = semSurvivorRanks.get(r.id);
    let fused = 0;
    if (lexRank !== undefined) fused += 1 / (RRF_K + lexRank);
    if (semRank !== undefined) fused += 1 / (RRF_K + semRank);
    return {
      id: r.id,
      score: fused,
      relevant: lexRank !== undefined || semRank !== undefined,
    };
  });
}
