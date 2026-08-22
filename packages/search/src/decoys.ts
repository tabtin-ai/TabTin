/**
 * 语义路诱饵锚点 —— 给相对门槛补「无关绝对基线」。
 *
 * e5-small 的余弦分未校准：中文 query × 中文描述即使完全无关也在 0.83~0.86，
 * 纯 z-score / 池内均值边际只能筛「比同池其他候选更像 query」，无法回答
 * 「这个 query 跟整池是否都无关」。诱饵是一组与平台能力域无关的固定短句，
 * query 对诱饵的最高分 = 该 query 在该文字系统下的「无关相似度基线」；
 * 候选须显著高于对应基线才算语义命中。
 *
 * 文字系统分两桶（CJK / Latin，按字符占比判定，非业务硬编码）：中文 query ×
 * 英文候选比对 Latin 诱饵基线（天然更低），跨语言真命中（0.80~0.83）不被
 * 中文诱饵基线误杀。
 */

import type { RankItem } from './bm25.js';

/** 诱饵条目在 scorer 返回结果里的 id 前缀——融合层剥离，不进入 RRF。 */
export const DECOY_ID_PREFIX = '__decoy__:';

/**
 * 候选须高出对应文字系统诱饵基线的最小绝对边际。
 * live 校准（e5-small）取 0.02；与 z-score / 绝对保底取更严者。
 */
export const DECOY_MARGIN = 0.02;

export type TextScript = 'cjk' | 'latin';

export interface SemanticDecoy {
  id: string;
  /** passage 侧文本（含 e5 前缀），与真实候选同一侧。 */
  text: string;
  script: TextScript;
}

/**
 * 固定诱饵语料：与 skill/CLI/MCP 能力域无关，中英各半。
 *
 * 覆盖两类「无关」：
 * - 知识陈述域（天气/烹饪/历史等）——普通无关 query 的基线；
 * - 日常闲聊域（时间/问候/寒暄）——「现在几点了」这类闲聊 query 会与
 *   带表面时间词的工具描述（「每天18~19点更新」）共振到 0.88+，只有
 *   同域诱饵才能把基线顶到共振簇之上（live 校准见 ）。
 */
export const SEMANTIC_DECOYS: readonly SemanticDecoy[] = [
  { id: `${DECOY_ID_PREFIX}cjk:weather`, text: 'passage: 今天天气晴朗，适合出门散步。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:cooking`, text: 'passage: 这道番茄炒蛋的做法很简单。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:history`, text: 'passage: 唐朝是中国历史上繁荣的时期。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:geography`, text: 'passage: 长江是中国最长的河流。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:literature`, text: 'passage: 李白是唐代著名诗人。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:music`, text: 'passage: 古典音乐会在周末举行。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:sports`, text: 'passage: 篮球比赛在体育馆进行。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:garden`, text: 'passage: 春天适合在院子里种花。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:time`, text: 'passage: 现在是下午三点，时间过得真快。', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:greeting`, text: 'passage: 你好，最近过得怎么样？', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}cjk:smalltalk`, text: 'passage: 周末打算去哪里玩？', script: 'cjk' },
  { id: `${DECOY_ID_PREFIX}latin:weather`, text: 'passage: The weather is sunny and pleasant today.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:cooking`, text: 'passage: This pasta recipe is easy to follow.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:history`, text: 'passage: The Roman Empire lasted for centuries.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:geography`, text: 'passage: The Nile is one of the longest rivers.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:literature`, text: 'passage: Shakespeare wrote many famous plays.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:music`, text: 'passage: The symphony concert starts at eight.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:sports`, text: 'passage: The basketball game is at the arena.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:garden`, text: 'passage: Spring is a good time to plant flowers.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:time`, text: 'passage: It is three in the afternoon, time flies.', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:greeting`, text: 'passage: Hello, how have you been lately?', script: 'latin' },
  { id: `${DECOY_ID_PREFIX}latin:smalltalk`, text: 'passage: Any plans for the weekend?', script: 'latin' },
] as const;

/** 按文字系统分桶的诱饵基线（query 对该桶诱饵的最高分）。 */
export interface DecoyBaselines {
  cjk: number;
  latin: number;
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const LATIN_RE = /[A-Za-z]/g;

/** 判定文本主文字系统：CJK 字符占比 ≥ 15% 视为 CJK，否则 Latin。 */
export function detectTextScript(text: string): TextScript {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const latin = (text.match(LATIN_RE) ?? []).length;
  const total = cjk + latin;
  if (total === 0) return 'latin';
  return cjk / total >= 0.15 ? 'cjk' : 'latin';
}

/** 文本是否含指定文字系统的任意字符。 */
function containsScript(text: string, script: TextScript): boolean {
  // 正则带 g flag，test 会推进 lastIndex——用 match 避免状态泄漏。
  const re = script === 'cjk' ? CJK_RE : LATIN_RE;
  return (text.match(re) ?? []).length > 0;
}

export function isDecoyId(id: string): boolean {
  return id.startsWith(DECOY_ID_PREFIX);
}

export function decoyRankItems(): RankItem[] {
  return SEMANTIC_DECOYS.map((d) => ({ id: d.id, text: d.text }));
}

/** 从 scorer 返回的诱饵条目中提取各文字系统基线（缺桶时基线为 0）。 */
export function computeDecoyBaselines(decoyScores: readonly { id: string; score: number }[]): DecoyBaselines {
  const baselines: DecoyBaselines = { cjk: 0, latin: 0 };
  for (const d of SEMANTIC_DECOYS) {
    const hit = decoyScores.find((s) => s.id === d.id);
    if (!hit) continue;
    baselines[d.script] = Math.max(baselines[d.script], hit.score);
  }
  return baselines;
}

/**
 * 候选在对应文字系统下须达到的最低语义分（诱饵基线 + 边际）。
 *
 * 基线取「候选主文字系统」与「query 主文字系统」中的更严者：e5-small 下
 * 同语言对的相似度天然高于跨语言对——中文 query × 混排候选（如
 * `slide grep 全文本搜索`）虽被判为 Latin 主导，但其得分仍受同语言
 * 抬升（live 取证 0.86~0.87 > Latin 基线 0.81），只按候选 script 取
 * Latin 基线会整簇放行。含 query 同文字系统字符的候选须同时过 query
 * 侧基线；纯外语候选（真跨语言场景）仍只比对自身基线，不被误杀。
 */
export function decoyCutoffForText(
  text: string,
  baselines: DecoyBaselines,
  query?: string,
): number {
  const script = detectTextScript(text);
  let baseline = script === 'cjk' ? baselines.cjk : baselines.latin;
  if (query) {
    const queryScript = detectTextScript(query);
    if (queryScript !== script && containsScript(text, queryScript)) {
      const queryBaseline = queryScript === 'cjk' ? baselines.cjk : baselines.latin;
      baseline = Math.max(baseline, queryBaseline);
    }
  }
  return baseline + DECOY_MARGIN;
}
