/**
 * SemanticScorer 适配 —— 语义双路召回。
 *
 * 把 `LocalEmbeddingService` 包装成 `@tabtin/search` 的
 * `WarmableSemanticScorer`——双路召回抽成独立通用包后，接口就是包间契约，
 * 不再需要 duck typing 对齐。
 */

import type { RankItem, RankResult, WarmableSemanticScorer } from '@tabtin/search';
import type { LocalEmbeddingService } from './local-embedding-service.js';

/** 归一化向量的点积 = 余弦相似度。 */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * 返回 null 的语义（对齐 dual-recall 契约）：本轮语义路不可用——模型未就绪、
 * 查询推理失败。候选中个别向量缺失（未就绪期缓存未命中）只跳过该条。
 */
export function createSemanticScorer(service: LocalEmbeddingService): WarmableSemanticScorer {
  return {
    async score(items: readonly RankItem[], query: string): Promise<RankResult[] | null> {
      if (items.length === 0) return [];
      const queryVec = await service.embedQuery(query);
      if (!queryVec) return null;
      const passageVecs = await service.embedPassages(items.map((it) => it.text));
      const results: RankResult[] = [];
      for (let i = 0; i < items.length; i++) {
        const vec = passageVecs[i];
        if (!vec) continue;
        results.push({ id: items[i].id, score: dot(queryVec, vec) });
      }
      return results;
    },
    warm(items: readonly RankItem[]): void {
      if (items.length === 0) return;
      // embedPassages 自带缓存去重（命中即跳过推理）与失败日志，这里只管触发。
      void service.embedPassages(items.map((it) => it.text)).catch(() => {});
    },
  };
}
