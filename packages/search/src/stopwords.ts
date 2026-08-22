/**
 * query 侧停用词 —— 词法相关性打分（`bm25.ts`）专用。
 *
 * 为什么需要：BM25 的 IDF 只能「降权」高频虚词，不能归零。当候选池里几乎
 * 每条描述都带「的」（中文描述必然如此），一个只与候选重合了「的」的 query
 * 仍会给出非零分；而相对阈值按当轮最高分归一——全员都是虚词噪音分时，
 * 整批噪音一起过阈（live 取证：「帮我截一张当前屏幕的图」把全部 tushare
 * 行情工具带进 `<relevant_mcp>`，重合 token 只有「的」）。
 *
 * 只过滤 query 侧：文档侧 token 仅在命中 query token 时参与计分，query 干净
 * 了文档侧自然干净。表刻意保持小——只收「几乎不承载检索意图」的功能词，
 * 宁缺勿滥；领域词一律不进表。
 */

/** 中文功能词：助词、代词、介词、常见客套动词。 */
const CJK_STOPWORDS = [
  '的', '了', '着', '过', '是', '在', '把', '被', '给', '让', '将',
  '和', '与', '或', '及', '也', '都', '还', '就', '才', '又', '很',
  '我', '你', '他', '她', '它', '咱', '您',
  '这', '那', '哪', '之', '其', '此',
  '吗', '呢', '吧', '啊', '呀', '嘛',
  '帮', '请', '想', '要', '能', '可以', '一下', '一个', '什么', '怎么',
  '帮我', '请问', '麻烦', '需要', '如何', '现在', '今天', '明天', '昨天',
];

/** 英文功能词：冠词、介词、代词、常见请求用语。 */
const EN_STOPWORDS = [
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by',
  'and', 'or', 'not', 'is', 'are', 'was', 'be', 'do', 'does', 'did',
  'i', 'me', 'my', 'you', 'your', 'it', 'this', 'that', 'these', 'those',
  'please', 'help', 'can', 'could', 'would', 'want', 'need', 'how', 'what',
  'now', 'today',
];

export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  ...CJK_STOPWORDS,
  ...EN_STOPWORDS,
]);

/**
 * 过滤 query token 中的停用词。全部被过滤时返回原数组——
 * 「全是虚词的 query」退回原行为，好过直接判全员无关。
 */
export function filterQueryStopwords(tokens: readonly string[]): readonly string[] {
  const kept = tokens.filter((t) => !QUERY_STOPWORDS.has(t));
  return kept.length > 0 ? kept : tokens;
}
