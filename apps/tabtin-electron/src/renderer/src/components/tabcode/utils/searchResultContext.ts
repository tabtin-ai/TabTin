/**
 * 搜索结果 hover 上下文：从文件内容截取匹配行相邻若干行。
 * 按文件缓存整文件行数组，同文件多条匹配只读盘一次。
 */

export const SEARCH_RESULT_CONTEXT_RADIUS = 2
export const SEARCH_RESULT_CONTEXT_MAX_BYTES = 256 * 1024
export const SEARCH_RESULT_CONTEXT_TOOLTIP_DELAY_MS = 280

export type SearchResultContextCache = Map<string, string[] | 'unavailable'>

export interface SearchContextLine {
  lineNumber: number
  text: string
  isMatch: boolean
}

export function sliceSearchContextLines(
  lines: string[],
  matchLine: number,
  radius: number = SEARCH_RESULT_CONTEXT_RADIUS,
): SearchContextLine[] | null {
  if (!Number.isFinite(matchLine) || matchLine < 1 || matchLine > lines.length) {
    return null
  }
  const start = Math.max(1, matchLine - radius)
  const end = Math.min(lines.length, matchLine + radius)
  const snippet: SearchContextLine[] = []
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    snippet.push({
      lineNumber,
      text: lines[lineNumber - 1] ?? '',
      isMatch: lineNumber === matchLine,
    })
  }
  return snippet
}

export async function loadSearchResultContext(
  filePath: string,
  matchLine: number,
  cache: SearchResultContextCache,
  radius: number = SEARCH_RESULT_CONTEXT_RADIUS,
): Promise<SearchContextLine[] | null> {
  if (!filePath || !Number.isFinite(matchLine) || matchLine < 1) {
    return null
  }

  let cached = cache.get(filePath)
  if (cached === 'unavailable') {
    return null
  }

  if (!cached) {
    try {
      const preview = await window.tabtin.fileSystem.readFilePreview(filePath, {
        maxBytes: SEARCH_RESULT_CONTEXT_MAX_BYTES,
      })
      if (
        !preview.success ||
        preview.data?.kind !== 'text' ||
        typeof preview.data.content !== 'string'
      ) {
        cache.set(filePath, 'unavailable')
        return null
      }
      cached = preview.data.content.split(/\r?\n/)
      cache.set(filePath, cached)
    } catch {
      cache.set(filePath, 'unavailable')
      return null
    }
  }

  return sliceSearchContextLines(cached, matchLine, radius)
}
