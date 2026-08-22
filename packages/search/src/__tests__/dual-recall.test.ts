import { describe, expect, it } from 'vitest';
import type { RankItem, RankResult } from '../bm25.js';
import { rankByRelevance, RELEVANCE_RELATIVE_THRESHOLD } from '../bm25.js';
import type { SemanticScorer } from '../dual-recall.js';
import {
  rankDualPath,
  SEMANTIC_SIMILARITY_FLOOR,
  SEMANTIC_ZSCORE_MIN_CANDIDATES,
} from '../dual-recall.js';
import { isDecoyId } from '../decoys.js';

const ITEMS: RankItem[] = [
  { id: 'screenshot', text: 'screenshot capture the current window as an image' },
  { id: 'email', text: 'send an email message to a recipient' },
  { id: 'calendar', text: 'create a calendar event with attendees' },
];

/** 固定分数表的假语义打分器；诱饵按文字系统给默认分（模拟 e5 跨语言基线差）。 */
function fakeScorer(
  scores: Record<string, number>,
  decoyScores: { cjk?: number; latin?: number } = { cjk: 0.82, latin: 0.78 },
): SemanticScorer {
  return {
    async score(items) {
      const out: RankResult[] = [];
      for (const it of items) {
        if (scores[it.id] !== undefined) {
          out.push({ id: it.id, score: scores[it.id] });
        } else if (isDecoyId(it.id)) {
          const script = it.id.includes(':cjk:') ? 'cjk' : 'latin';
          out.push({
            id: it.id,
            score: decoyScores[script] ?? 0.82,
          });
        }
      }
      return out;
    },
  };
}

/** 复现纯词法路的期望输出：BM25 分 + 相对阈值判定。 */
function lexicalExpectation(items: RankItem[], query: string) {
  const scores = rankByRelevance(items, query);
  const maxScore = scores.reduce((m, r: RankResult) => Math.max(m, r.score), 0);
  const cutoff = maxScore * RELEVANCE_RELATIVE_THRESHOLD;
  return scores.map((r) => ({
    id: r.id,
    score: r.score,
    relevant: maxScore > 0 && r.score > 0 && r.score >= cutoff,
  }));
}

describe('rankDualPath 兜底契约：与纯词法路逐条一致', () => {
  const query = 'send email';

  it('scorer 未注入', async () => {
    expect(await rankDualPath(ITEMS, query)).toEqual(lexicalExpectation(ITEMS, query));
  });

  it('scorer 返回 null（模型未就绪）', async () => {
    const scorer: SemanticScorer = { score: async () => null };
    expect(await rankDualPath(ITEMS, query, scorer)).toEqual(
      lexicalExpectation(ITEMS, query),
    );
  });

  it('scorer 抛错', async () => {
    const scorer: SemanticScorer = {
      score: async () => {
        throw new Error('inference crashed');
      },
    };
    expect(await rankDualPath(ITEMS, query, scorer)).toEqual(
      lexicalExpectation(ITEMS, query),
    );
  });

  it('scorer 超时', async () => {
    const scorer: SemanticScorer = {
      score: () => new Promise((resolve) => setTimeout(() => resolve([]), 5_000)),
    };
    expect(
      await rankDualPath(ITEMS, query, scorer, { timeoutMs: 10 }),
    ).toEqual(lexicalExpectation(ITEMS, query));
  });

  it('空 query 不调 scorer，全员 score 0 / relevant false', async () => {
    let called = false;
    const scorer: SemanticScorer = {
      score: async () => {
        called = true;
        return [];
      },
    };
    const results = await rankDualPath(ITEMS, '   ', scorer);
    expect(called).toBe(false);
    expect(results.every((r) => r.score === 0 && !r.relevant)).toBe(true);
  });
});

describe('rankDualPath 双路融合', () => {
  it('语义独有命中（词法零重合）进入结果——核心收益', async () => {
    // 中文 query 与英文候选无词法重合
    const query = '帮我截个图';
    const scorer = fakeScorer({ screenshot: 0.91 });
    const results = await rankDualPath(ITEMS, query, scorer);
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get('screenshot')!.relevant).toBe(true);
    expect(byId.get('screenshot')!.score).toBeGreaterThan(0);
    expect(byId.get('email')!.relevant).toBe(false);
    expect(byId.get('calendar')!.relevant).toBe(false);
  });

  it('两路都命中的候选融合分高于单路命中', async () => {
    const query = 'send email';
    // email 词法命中 + 语义命中；screenshot 仅语义命中
    const scorer = fakeScorer({ email: 0.9, screenshot: 0.85 });
    const results = await rankDualPath(ITEMS, query, scorer);
    const byId = new Map(results.map((r) => [r.id, r.score]));

    expect(byId.get('email')!).toBeGreaterThan(byId.get('screenshot')!);
  });

  it('低于绝对保底的相似度不进入语义路', async () => {
    const query = '帮我截个图';
    const scorer = fakeScorer({
      screenshot: SEMANTIC_SIMILARITY_FLOOR - 0.01,
    });
    const results = await rankDualPath(ITEMS, query, scorer);
    expect(results.every((r) => !r.relevant)).toBe(true);
  });

  it('大候选池按 z-score 过滤：只有离群高分命中', async () => {
    const many: RankItem[] = Array.from(
      { length: SEMANTIC_ZSCORE_MIN_CANDIDATES + 4 },
      (_, i) => ({ id: `item${i}`, text: `candidate number ${i}` }),
    );
    // 基线拥挤在 0.84 附近（高于绝对保底），仅 item0 离群
    const scores = Object.fromEntries(many.map((it) => [it.id, 0.84]));
    scores.item0 = 0.95;
    const results = await rankDualPath(many, '无词法重合的查询', fakeScorer(scores));
    const relevant = results.filter((r) => r.relevant).map((r) => r.id);
    expect(relevant).toEqual(['item0']);
  });

  it('同质无关池不放行：分布极窄时 z-score 虚高，被绝对边际拦住', async () => {
    // 模拟全库 tushare 行情工具遇到无关查询：分数拥挤在 0.84~0.851，
    // 最高分 z-score 虽离群（std 极小所致）但对均值边际 < SEMANTIC_MEAN_MARGIN
    const many: RankItem[] = Array.from(
      { length: SEMANTIC_ZSCORE_MIN_CANDIDATES + 4 },
      (_, i) => ({ id: `item${i}`, text: `candidate number ${i}` }),
    );
    const scores = Object.fromEntries(many.map((it, i) => [it.id, 0.84 + i * 0.001]));
    const results = await rankDualPath(many, '无词法重合的查询', fakeScorer(scores));
    expect(results.every((r) => !r.relevant)).toBe(true);
  });

  it('小候选池退化为绝对保底过滤（z-score 无统计意义）', async () => {
    // ITEMS 只有 3 条 < SEMANTIC_ZSCORE_MIN_CANDIDATES，一高一低也应保留高分
    const query = '帮我截个图';
    const scorer = fakeScorer({ screenshot: 0.9, email: 0.5 });
    const results = await rankDualPath(ITEMS, query, scorer);
    const byId = new Map(results.map((r) => [r.id, r.relevant]));
    expect(byId.get('screenshot')).toBe(true);
    expect(byId.get('email')).toBe(false);
  });

  it('保持输入顺序返回全部条目', async () => {
    const query = 'send email';
    const scorer = fakeScorer({ screenshot: 0.9 });
    const results = await rankDualPath(ITEMS, query, scorer);
    expect(results.map((r) => r.id)).toEqual(ITEMS.map((it) => it.id));
  });

  it('诱饵基线拦住无关 query 的表面词共振簇（live tushare 场景）', async () => {
    const pool: RankItem[] = [
      { id: 'cyq_perf', text: 'cyq_perf 每日筹码及胜率 每天18~19点左右更新' },
      { id: 'report_rc', text: 'report_rc 券商盈利预测 每晚19~22点更新' },
      { id: 'cyq_chips', text: 'cyq_chips 每日筹码分布 每天18~19点之间更新' },
      ...Array.from({ length: SEMANTIC_ZSCORE_MIN_CANDIDATES }, (_, i) => ({
        id: `pad${i}`,
        text: `pad${i} 获取A股每日衍生数据`,
      })),
    ];
    const scores = Object.fromEntries(
      pool.map((it) => [it.id, it.id === 'cyq_perf' ? 0.882 : it.id === 'report_rc' ? 0.876 : 0.87]),
    );
    // 诱饵基线 0.82 + margin 0.02 = 0.84；离群 0.882 仍过——需诱饵基线贴近 query
    const results = await rankDualPath(
      pool,
      '现在几点了',
      fakeScorer(scores, { cjk: 0.865, latin: 0.78 }),
    );
    expect(results.every((r) => !r.relevant)).toBe(true);
  });

  it('跨语言真命中不被中文诱饵基线误杀', async () => {
    const pool: RankItem[] = [
      { id: 'en:screenshot', text: 'Capture a screenshot of the current screen or display' },
    ];
    const results = await rankDualPath(
      pool,
      '帮我截一张当前屏幕的图',
      fakeScorer({ 'en:screenshot': 0.82 }, { cjk: 0.86, latin: 0.78 }),
    );
    expect(results[0]?.relevant).toBe(true);
  });

  it('语义路超过 Top 上限时只保留最高的一批', async () => {
    const many: RankItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: `item${i}`,
      text: `candidate number ${i}`,
    }));
    // 全部 20 条语义分递增，仅最高的 SEMANTIC_TOP_CAP 条应 relevant
    const scores = Object.fromEntries(
      many.map((it, i) => [it.id, 0.81 + i * 0.005]),
    );
    const results = await rankDualPath(many, '无词法重合的查询', fakeScorer(scores));
    const relevant = results.filter((r) => r.relevant);
    expect(relevant.length).toBeLessThanOrEqual(8);
    // 命中的应是分数最高的一批（item12..item19）
    expect(relevant.map((r) => r.id)).toEqual(
      many.slice(-relevant.length).map((it) => it.id),
    );
  });
});
