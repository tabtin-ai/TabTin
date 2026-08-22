/**
 * Legacy WebSearch 工具 stdout markdown 解析（**[title](url)** + 下一行 snippet）。
 */

export interface LegacyWebSearchResult {
  title: string
  url: string
  snippet: string
}

const LINK_PATTERN = /\*\*\[(.+?)\]\((.+?)\)\*\*/g

export function parseLegacyWebSearchMarkdown(output: string): LegacyWebSearchResult[] {
  const results: LegacyWebSearchResult[] = []
  let match: RegExpExecArray | null
  while ((match = LINK_PATTERN.exec(output)) !== null) {
    results.push({ title: match[1], url: match[2], snippet: '' })
  }
  if (results.length === 0) return results

  const lines = output.split('\n')
  for (let i = 0; i < results.length; i++) {
    const snippet = findSnippetAfterUrl(lines, results[i].url)
    if (snippet) results[i].snippet = snippet
  }
  return results
}

function findSnippetAfterUrl(lines: string[], url: string): string {
  const urlLine = lines.findIndex(line => line.includes(url))
  if (urlLine < 0 || urlLine + 1 >= lines.length) return ''
  const nextLine = lines[urlLine + 1]?.trim()
  if (!nextLine || nextLine.startsWith('-') || nextLine.startsWith('*')) return ''
  return nextLine.slice(0, 200)
}
