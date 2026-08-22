/** CJK + 日文假名 + 韩文音节 — 文档字数统计中按单字计数。 */
const CJK_CHAR_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g

/**
 * 统计文档字数：CJK 逐字 + 非 CJK 按空白分隔的词。
 * 与 WPS/Word 中文模式一致，供工具栏展示与 runtime monitor 共用。
 */
export function countDocumentWords(plaintext: string): number {
  if (!plaintext) return 0

  const cjkMatches = plaintext.match(CJK_CHAR_PATTERN)
  const cjkCount = cjkMatches ? cjkMatches.length : 0

  const nonCjk = plaintext.replace(CJK_CHAR_PATTERN, ' ')
  const wordMatches = nonCjk.match(/\S+/g)
  const wordCount = wordMatches ? wordMatches.length : 0

  return cjkCount + wordCount
}
