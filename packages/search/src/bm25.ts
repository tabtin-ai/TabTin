/**
 * 通用词法相关性打分（BM25）—— 零运行时依赖。
 *
 * 职责：给定一批候选条目（`{ id, text }`）与一个 query，返回每个条目对 query 的
 * 相关性分数。**与业务无关**：本期由 skill listing 消费（`skill-budget.ts` 用它
 * 做相关性排序 + 分级曝光），后续 app / tool 发现可复用同一函数。
 *
 * 为什么 BM25 而非 pi Python 版的 set-overlap：
 *   - set-overlap 无权重——`的/和/code/file` 等高频泛词与关键词同等计分，噪音大。
 *   - BM25 带 IDF 降权（越普遍的词贡献越小）+ 文档长度归一（长描述不因词多而虚高），
 *     是搜索系统的标准词法打分，质量明显更高，实现也只是一段纯函数。
 *
 * 规模：候选条目为几十到几百量级，直接全量线性打分，无需倒排索引 / ANN。
 */

import { filterQueryStopwords } from './stopwords.js';
import { tokenize } from './tokenize.js';

export interface RankItem {
  /** 稳定标识（如 skill 的 canonicalKey），原样回填到结果。 */
  id: string;
  /** 参与打分的文本（如 name + description + whenToUse 拼接）。 */
  text: string;
}

export interface RankResult {
  id: string;
  /** BM25 分数；>0 表示与 query 有词法重合，0 表示无关。 */
  score: number;
}

export interface RankOptions {
  /** BM25 词频饱和参数，默认 1.5。 */
  k1?: number;
  /** BM25 文档长度归一强度，默认 0.75。 */
  b?: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/**
 * 动态召回的相对相关性阈值（skills / MCP / CLI 共用）。
 *
 * BM25 只要 query 与候选有任意词法重合就给 `score > 0`（泛词被 IDF 降权但不归零），
 * 光按 `score > 0 + Top-N` 会在只有一两条强命中时硬凑弱条目进来。加这道相对阈值：
 * 只保留 `score >= maxScore * 阈值` 的候选，再取 Top-N——一条强命中时不再带出弱噪音。
 *
 * 相对（按当轮最高分归一）而非绝对：BM25 绝对分随语料规模 / query 长度漂移，相对更稳。
 */
export const RELEVANCE_RELATIVE_THRESHOLD = 0.2;

/**
 * 按 BM25 给候选条目相对 query 打分。**保持输入顺序**（不排序），分数由调用方
 * 自行使用/排序——让调用方能自定义 tie-break 与二次信号叠加。
 *
 * query 为空或分词后无 token 时，所有条目得 0 分（调用方据此回退到默认策略）。
 */
export function rankByRelevance(
  items: readonly RankItem[],
  query: string,
  options?: RankOptions,
): RankResult[] {
  // query 侧滤停用词：虚词（的/我/the/to…）只与候选虚词重合时不应产生非零分，
  // 否则相对阈值下整批噪音一起过阈（根因分析见 stopwords.ts 文件头）。
  const queryTokens = new Set(filterQueryStopwords(tokenize(query)));
  if (queryTokens.size === 0 || items.length === 0) {
    return items.map((it) => ({ id: it.id, score: 0 }));
  }

  const k1 = options?.k1 ?? DEFAULT_K1;
  const b = options?.b ?? DEFAULT_B;

  // 预分词每个文档 + 统计文档频率（df）与平均文档长度（avgdl）。
  const docTokens = items.map((it) => tokenize(it.text));
  const N = docTokens.length;

  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const totalLen = docTokens.reduce((acc, t) => acc + t.length, 0);
  const avgdl = totalLen / N || 1;

  return items.map((item, idx) => {
    const tokens = docTokens[idx];
    const dl = tokens.length;

    const tf = new Map<string, number>();
    for (const t of tokens) {
      if (queryTokens.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    let score = 0;
    for (const [term, freq] of tf) {
      const n = df.get(term) ?? 0;
      // BM25 IDF（加 1 保证非负，避免半数以上文档含该词时出现负 IDF）。
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = freq + k1 * (1 - b + (b * dl) / avgdl);
      score += idf * ((freq * (k1 + 1)) / denom);
    }

    return { id: item.id, score };
  });
}
