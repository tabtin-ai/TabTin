/**
 * Skill 动态段召回端口（ Stage 6c）。
 *
 * Runtime 不再依赖 `@tabtin/search`。宿主必须注入实现（典型：`new RecallIndex({ scorer })`）。
 * {@link createLexicalSkillRecall} 仅供单测 / 离线 harness，不作生产缺省回落。
 */

export interface SkillRecallItem {
  id: string;
  text: string;
}

export interface SkillRecallHit {
  id: string;
  score: number;
  relevant: boolean;
}

export interface SkillRecallPort {
  replaceAll(domain: string, items: readonly SkillRecallItem[]): void;
  query(domain: string, queryText: string): Promise<SkillRecallHit[]>;
}

// ─── 本地词法 fallback（自 @tabtin/search bm25/tokenize/stopwords 精简迁入）────

const RELEVANCE_RELATIVE_THRESHOLD = 0.2;
const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  '的', '了', '着', '过', '是', '在', '把', '被', '给', '让', '将',
  '和', '与', '或', '及', '也', '都', '还', '就', '才', '又', '很',
  '我', '你', '他', '她', '它', '咱', '您',
  '这', '那', '哪', '之', '其', '此',
  '吗', '呢', '吧', '啊', '呀', '嘛',
  '帮', '请', '想', '要', '能', '可以', '一下', '一个', '什么', '怎么',
  '帮我', '请问', '麻烦', '需要', '如何', '现在', '今天', '明天', '昨天',
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by',
  'and', 'or', 'not', 'is', 'are', 'was', 'be', 'do', 'does', 'did',
  'i', 'me', 'my', 'you', 'your', 'it', 'this', 'that', 'these', 'those',
  'please', 'help', 'can', 'could', 'would', 'want', 'need', 'how', 'what',
  'now', 'today',
]);

let _segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter !== undefined) return _segmenter;
  try {
    _segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  } catch {
    _segmenter = null;
  }
  return _segmenter;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const seg = getSegmenter();
  if (!seg) {
    return lower.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  }
  const out: string[] = [];
  for (const part of seg.segment(lower)) {
    if (part.isWordLike && part.segment.trim()) {
      out.push(part.segment);
    }
  }
  return out;
}

function filterQueryStopwords(tokens: readonly string[]): readonly string[] {
  const kept = tokens.filter((t) => !QUERY_STOPWORDS.has(t));
  return kept.length > 0 ? kept : tokens;
}

function rankByRelevance(
  items: readonly SkillRecallItem[],
  query: string,
): Array<{ id: string; score: number }> {
  const queryTokens = new Set(filterQueryStopwords(tokenize(query)));
  if (queryTokens.size === 0 || items.length === 0) {
    return items.map((it) => ({ id: it.id, score: 0 }));
  }

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
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = freq + DEFAULT_K1 * (1 - DEFAULT_B + (DEFAULT_B * dl) / avgdl);
      score += idf * ((freq * (DEFAULT_K1 + 1)) / denom);
    }
    return { id: item.id, score };
  });
}

/** 纯词法 SkillRecallPort（无语义路；与 search 在 scorer 缺席时行为对齐）。 */
export function createLexicalSkillRecall(): SkillRecallPort {
  const domains = new Map<string, Map<string, SkillRecallItem>>();

  return {
    replaceAll(domain, items) {
      const next = new Map<string, SkillRecallItem>();
      for (const item of items) next.set(item.id, item);
      domains.set(domain, next);
    },
    async query(domain, queryText) {
      const store = domains.get(domain);
      const items = store ? [...store.values()] : [];
      const scores = rankByRelevance(items, queryText);
      const maxScore = scores.reduce((m, r) => Math.max(m, r.score), 0);
      const cutoff = maxScore > 0 ? maxScore * RELEVANCE_RELATIVE_THRESHOLD : 0;
      return scores.map((r) => ({
        id: r.id,
        score: r.score,
        relevant: r.score > 0 && r.score >= cutoff,
      }));
    },
  };
}
