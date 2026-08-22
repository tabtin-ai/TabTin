/**
 * Quick Open 搜索词高亮区间计算。
 *
 * 与 useFileSearch 的召回语义对齐：优先按大小写不敏感的连续子串命中
 * （对应索引的 exact 分支）；子串不命中时退化为贪心逐字匹配（对应
 * Fuse 模糊分支——Fuse 实例在 hook 内部持有，这里不复用其 matches，
 * 用同样宽松的字符子序列近似定位命中字符）。
 */

export interface HighlightRange {
  start: number
  /** 不含端点（slice 语义）。 */
  end: number
}

interface ComputeHighlightOptions {
  /**
   * 子串不命中时是否退化为逐字子序列高亮。长文本（如相对路径）
   * 关掉它，避免散落的单字母高亮制造噪音。
   */
  fuzzy?: boolean
}

export function computeHighlightRanges(
  text: string,
  query: string,
  { fuzzy = true }: ComputeHighlightOptions = {},
): HighlightRange[] {
  const term = query.trim()
  if (!term || !text) return []

  const lowerText = text.toLocaleLowerCase()
  const lowerTerm = term.toLocaleLowerCase()

  // 连续子串：高亮所有出现位置。
  const ranges: HighlightRange[] = []
  let from = 0
  while (from <= lowerText.length - lowerTerm.length) {
    const idx = lowerText.indexOf(lowerTerm, from)
    if (idx === -1) break
    ranges.push({ start: idx, end: idx + lowerTerm.length })
    from = idx + lowerTerm.length
  }
  if (ranges.length > 0) return ranges
  if (!fuzzy) return []

  // 贪心子序列：全部查询字符按序命中才高亮，否则视为未命中该字段。
  const matchedIndexes: number[] = []
  let cursor = 0
  for (const ch of lowerTerm) {
    if (ch === ' ') continue
    const idx = lowerText.indexOf(ch, cursor)
    if (idx === -1) return []
    matchedIndexes.push(idx)
    cursor = idx + 1
  }

  // 相邻命中字符合并成连续区间，减少 DOM 片段数量。
  for (const idx of matchedIndexes) {
    const last = ranges[ranges.length - 1]
    if (last && last.end === idx) last.end = idx + 1
    else ranges.push({ start: idx, end: idx + 1 })
  }
  return ranges
}

/** 把文本按高亮区间切成交替片段，供渲染层包裹高亮样式。 */
export function splitByHighlightRanges(
  text: string,
  ranges: HighlightRange[],
): Array<{ text: string; highlighted: boolean }> {
  if (ranges.length === 0) return [{ text, highlighted: false }]
  const segments: Array<{ text: string; highlighted: boolean }> = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), highlighted: false })
    }
    segments.push({ text: text.slice(range.start, range.end), highlighted: true })
    cursor = range.end
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false })
  }
  return segments
}
