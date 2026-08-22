import { describe, expect, it, vi } from 'vitest';

import { RecallIndex } from '../recall-index.js';
import type { RankItem, RankResult } from '../bm25.js';
import type { SemanticScorer } from '../dual-recall.js';

function makeScorer(scores: Record<string, number> = {}): SemanticScorer & {
  warm: ReturnType<typeof vi.fn>;
} {
  return {
    score: async (items: readonly RankItem[]): Promise<RankResult[]> =>
      items.map((it) => ({ id: it.id, score: scores[it.id] ?? 0 })),
    warm: vi.fn(),
  };
}

describe('RecallIndex CRUD', () => {
  it('upsert 增改、get/list 查、remove 删、clear 清空', () => {
    const index = new RecallIndex();
    index.upsert('d', [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    expect(index.get('d', 'a')).toEqual({ id: 'a', text: 'alpha' });
    expect(index.list('d').map((it) => it.id)).toEqual(['a', 'b']);

    index.upsert('d', [{ id: 'a', text: 'alpha v2' }]);
    expect(index.get('d', 'a')?.text).toBe('alpha v2');

    index.remove('d', ['b', 'not-exist']);
    expect(index.list('d').map((it) => it.id)).toEqual(['a']);

    index.clear('d');
    expect(index.list('d')).toEqual([]);
  });

  it('domain 之间互不干扰', () => {
    const index = new RecallIndex();
    index.upsert('skills', [{ id: 'x', text: 'skill x' }]);
    index.upsert('cli', [{ id: 'x', text: 'cli x' }]);

    expect(index.get('skills', 'x')?.text).toBe('skill x');
    expect(index.get('cli', 'x')?.text).toBe('cli x');

    index.clear('skills');
    expect(index.list('skills')).toEqual([]);
    expect(index.list('cli')).toHaveLength(1);
  });

  it('replaceAll 全量替换：不在快照里的旧条目被移除', () => {
    const index = new RecallIndex();
    index.replaceAll('d', [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    index.replaceAll('d', [{ id: 'b', text: 'beta' }]);
    expect(index.list('d').map((it) => it.id)).toEqual(['b']);
  });
});

describe('RecallIndex 向量预热', () => {
  it('upsert 只对新增/文本变更的条目触发 warm', () => {
    const scorer = makeScorer();
    const index = new RecallIndex({ scorer });

    index.upsert('d', [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    expect(scorer.warm).toHaveBeenCalledTimes(1);
    expect(scorer.warm.mock.calls[0][0].map((it: RankItem) => it.id)).toEqual(['a', 'b']);

    // 同内容重复 upsert：无变更 → 不再 warm
    index.upsert('d', [{ id: 'a', text: 'alpha' }]);
    expect(scorer.warm).toHaveBeenCalledTimes(1);

    // 文本变更 → 只 warm 变更条目
    index.upsert('d', [
      { id: 'a', text: 'alpha v2' },
      { id: 'b', text: 'beta' },
    ]);
    expect(scorer.warm).toHaveBeenCalledTimes(2);
    expect(scorer.warm.mock.calls[1][0].map((it: RankItem) => it.id)).toEqual(['a']);
  });

  it('replaceAll 与既有条目 diff：只 warm 新增/变更部分', () => {
    const scorer = makeScorer();
    const index = new RecallIndex({ scorer });

    index.replaceAll('d', [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    scorer.warm.mockClear();

    // 快照不变 → 不 warm
    index.replaceAll('d', [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    expect(scorer.warm).not.toHaveBeenCalled();

    // b 删除、c 新增 → 只 warm c
    index.replaceAll('d', [
      { id: 'a', text: 'alpha' },
      { id: 'c', text: 'gamma' },
    ]);
    expect(scorer.warm).toHaveBeenCalledTimes(1);
    expect(scorer.warm.mock.calls[0][0].map((it: RankItem) => it.id)).toEqual(['c']);
  });

  it('scorer 无 warm 能力 / 无 scorer 时静默跳过', () => {
    const scorerWithoutWarm: SemanticScorer = {
      score: async () => null,
    };
    expect(() => {
      new RecallIndex({ scorer: scorerWithoutWarm }).upsert('d', [{ id: 'a', text: 'x' }]);
      new RecallIndex().upsert('d', [{ id: 'a', text: 'x' }]);
    }).not.toThrow();
  });
});

describe('RecallIndex 检索', () => {
  it('query 走双路融合：词法命中 + 语义命中都在结果里', async () => {
    const scorer = makeScorer({ sem: 0.95, lex: 0.1 });
    const index = new RecallIndex({ scorer });
    index.replaceAll('d', [
      { id: 'lex', text: '截图 screenshot 工具' },
      { id: 'sem', text: 'capture screen content' },
      { id: 'noise', text: '完全无关的财务报表' },
    ]);

    const results = await index.query('d', '截图');
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('lex')?.relevant).toBe(true);
    // 小候选池走绝对保底过滤：0.95 ≥ floor → 语义路命中
    expect(byId.get('sem')?.relevant).toBe(true);
    expect(byId.get('noise')?.relevant).toBe(false);
  });

  it('无 scorer 时退纯词法路', async () => {
    const index = new RecallIndex();
    index.replaceAll('d', [
      { id: 'hit', text: '截图 screenshot' },
      { id: 'miss', text: 'unrelated finance' },
    ]);

    const results = await index.query('d', '截图');
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('hit')?.relevant).toBe(true);
    expect(byId.get('miss')?.relevant).toBe(false);
  });

  it('空 domain 返回空数组', async () => {
    const index = new RecallIndex();
    expect(await index.query('empty', '任意查询')).toEqual([]);
  });
});
