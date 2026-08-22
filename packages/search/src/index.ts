/**
 * @tabtin/search —— 通用搜索库，零运行时依赖。
 *
 * 定位以功能为界：候选集 × 查询 → 相关子集。当前实现为词法 BM25 +
 * 语义向量（宿主注入 `SemanticScorer`）的双路 RRF 融合；`RecallIndex`
 * 按 domain 管理候选集（CRUD + 检索 + 向量预热）。召回策略是内部实现，
 * 未来可演进（如重排、多路扩展）而不改包边界。
 * 业务无关：agent-runtime 的 skill / CLI / MCP 动态段是当前消费方。
 */

export { tokenize } from './tokenize.js';
export { rankByRelevance } from './bm25.js';
export type { RankItem, RankResult, RankOptions } from './bm25.js';
export {
  rankDualPath,
  RRF_K,
  SEMANTIC_MEAN_MARGIN,
  SEMANTIC_SCORE_TIMEOUT_MS,
  SEMANTIC_SIMILARITY_FLOOR,
  SEMANTIC_TOP_CAP,
  SEMANTIC_ZSCORE_THRESHOLD,
} from './dual-recall.js';
export type {
  DualRankOptions,
  DualRankResult,
  SemanticScorer,
} from './dual-recall.js';
export {
  DECOY_ID_PREFIX,
  DECOY_MARGIN,
  SEMANTIC_DECOYS,
  computeDecoyBaselines,
  decoyCutoffForText,
  decoyRankItems,
  detectTextScript,
  isDecoyId,
} from './decoys.js';
export type { DecoyBaselines, SemanticDecoy, TextScript } from './decoys.js';
export { RecallIndex } from './recall-index.js';
export type {
  RecallHit,
  RecallIndexOptions,
  RecallItem,
  RecallQueryOptions,
  RecallStore,
  WarmableSemanticScorer,
} from './recall-index.js';
