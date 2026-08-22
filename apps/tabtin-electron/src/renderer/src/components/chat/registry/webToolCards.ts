/**
 * 网络操作（搜索、浏览器截图）+ 外部 Agent 网络类工具。
 */

import type { ToolCardDescriptor, ToolOutputData } from '@tabtin/chat-client'
import { getNestedArgs, truncate, unwrapData, unwrapStringOrData } from './toolCardUtils'

function extractWebSearchQuery(input: unknown): string | null {
  const args = getNestedArgs(input)
  if (!args) return null
  const query = args.search_term ?? args.query ?? args.search_query ?? args.keyword
  if (typeof query !== 'string' || query.trim().length === 0) return null
  return truncate(query.trim(), 60)
}

export function extractWebSearch(output: unknown): ToolOutputData | null {
  if (!output) return null

  if (typeof output === 'object') {
    const obj = unwrapData(output)
    const resultRows = Array.isArray(obj._search_results) ? obj._search_results : obj.results
    if (Array.isArray(resultRows)) {
      return {
        kind: 'web_search',
        query: String(obj.query ?? ''),
        results: (resultRows as Array<Record<string, unknown>>).map(r => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? r.link ?? ''),
          snippet: String(r.snippet ?? r.description ?? ''),
        })),
      }
    }
  }

  const text = unwrapStringOrData(output)
  if (typeof text !== 'string' || text.length === 0) return null

  const results: Array<{ title: string; url: string; snippet: string }> = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let title = '', url = '', matchEnd = 0

    const titleMatch = line.match(/(?:\*\*)?(\[([^\]]+)]\s*\()/)
    if (!titleMatch) continue

    const isBold = line.slice(Math.max(0, (titleMatch.index ?? 0) - 2), (titleMatch.index ?? 0)).includes('**')
    title = titleMatch[2]
    const urlStart = (titleMatch.index ?? 0) + titleMatch[1].length

    let depth = 1
    let pos = urlStart
    while (pos < line.length && depth > 0) {
      if (line[pos] === '(') depth++
      else if (line[pos] === ')') depth--
      if (depth > 0) pos++
    }

    if (depth === 0) {
      url = line.slice(urlStart, pos)
      matchEnd = pos + 1
      if (isBold) {
        const tail = line.slice(matchEnd)
        if (tail.startsWith('**')) matchEnd += 2
      }
    } else {
      continue
    }

    const afterLink = line.slice(matchEnd).replace(/^[\s\-–—:]+/, '').trim()
    let snippet = afterLink

    if (!snippet) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim()
        if (!next || /^[-*#]/.test(next)) break
        if (!next.includes(url) && !next.match(/^\[.*]\s*\(.*\)/)) {
          snippet = next.slice(0, 300)
          break
        }
      }
    }

    results.push({ title, url, snippet: snippet.slice(0, 300) })
  }

  const queryMatch = text.match(/Search results for ['""'](.+?)['""']/) ?? text.match(/搜索[：:]?\s*(.+?)(?:\n|$)/)
  return {
    kind: 'web_search',
    query: queryMatch?.[1] ?? '',
    results: results.length > 0 ? results : undefined,
  }
}

export function extractWebFetch(output: unknown): ToolOutputData | null {
  if (!output) return null

  if (typeof output === 'object') {
    const obj = unwrapData(output)
    if (obj.url || obj.content || obj.content_preview || obj.text) {
      return {
        kind: 'web_page_fetch',
        url: String(obj.url ?? ''),
        title: obj.title as string | undefined,
        content_preview: String(obj.content ?? obj.content_preview ?? obj.text ?? '').slice(0, 1000),
      }
    }
  }

  const text = unwrapStringOrData(output)
  if (typeof text !== 'string' || text.length === 0) return null

  const urlPatterns = [/Content from (https?:\/\/\S+)/, /URL:\s*(https?:\/\/\S+)/i, /^(https?:\/\/\S+)/m]
  let detectedUrl = ''
  for (const pattern of urlPatterns) {
    const m = text.match(pattern)
    if (m) { detectedUrl = m[1].replace(/[.,;:!?)]+$/, ''); break }
  }
  const titleMatch = text.match(/^#{1,3}\s+(.+)$/m)
  return { kind: 'web_page_fetch', url: detectedUrl, title: titleMatch?.[1], content_preview: text.slice(0, 1000) }
}

export const WEB_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  web_search: {
    id: 'web_search', category: 'tool', labelKey: 'chat.card.web_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'WebSearchCard',
    compactSummary: extractWebSearchQuery, extractOutput: extractWebSearch,
  },
  get_tabs_info: {
    id: 'tabs_info', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },

  capture_screenshot: {
    id: 'web', category: 'tool', labelKey: 'chat.card.capture_screenshot', icon: 'Camera',
    riskLevel: 'safe', defaultCollapsed: false, renderer: 'ScreenshotCard',
  },

  /* ── 外部 Agent 网络类 ─── */
  WebSearch: {
    id: 'web_search', category: 'tool', labelKey: 'chat.card.web_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'WebSearchCard',
    compactSummary: extractWebSearchQuery, extractOutput: extractWebSearch,
  },
}

/**
 * Historical transcript display only.
 *
 * Retired page-fetch tool names, including `web_fetch`, are kept out of
 * WEB_TOOL_CARDS so the current tool registry never presents them as live
 * capabilities. getToolDescriptor() may consult this map only to render old
 * persisted messages clearly.
 */
export const HISTORICAL_WEB_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  browse_url: {
    id: 'historical_web_fetch', category: 'tool', labelKey: 'chat.card.historical_web_fetch', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'WebFetchCard', extractOutput: extractWebFetch,
  },
  web_fetch: {
    id: 'historical_web_fetch', category: 'tool', labelKey: 'chat.card.historical_web_fetch', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'WebFetchCard', extractOutput: extractWebFetch,
  },
  'web_scraper_scrape_url': {
    id: 'historical_web_scraper', category: 'tool', labelKey: 'chat.card.historical_web_fetch', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  'web_scraper_extract_fields': {
    id: 'historical_web_scraper', category: 'tool', labelKey: 'chat.card.historical_web_fetch', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  capture_webpage: {
    id: 'historical_web_capture', category: 'tool', labelKey: 'chat.card.historical_web_fetch', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  WebFetch: {
    id: 'historical_web_fetch', category: 'tool', labelKey: 'chat.card.historical_web_fetch', icon: 'Globe',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'WebFetchCard', extractOutput: extractWebFetch,
  },
}
