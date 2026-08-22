import { describe, expect, it } from 'vitest'
import {
  buildDiagnosticsClipboardText,
  truncateDiagnosticsClipboardText,
  filterLogEntriesSince,
  filterMainLogTextSince,
  filterTimedItemsSince,
  prepareClipboardDiagnostics,
  CLIPBOARD_WINDOW_MS,
} from '../buildDiagnosticsClipboardText'
import type { DiagnosticsMeta } from '../collectContext'

const baseMeta: DiagnosticsMeta = {
  generatedAt: '2026-07-08T08:00:00.000Z',
  reason: 'menu',
  profile: 'development',
  appVersion: '0.0.1',
  electronVersion: '',
  gitCommit: 'e3646f2c8bd7',
  gitBranch: 'release-20260609-0.0.1',
  os: { name: 'macOS', version: '15.0', arch: 'arm64', locale: 'zh-CN' },
  session: { sessionId: 's1', deviceId: 'd1' },
  context: {
    organizationId: null,
    organizationName: null,
    spaceId: null,
    spaceName: null,
    agentId: null,
    agentName: null,
  },
  user: {
    id: null,
    nickname: null,
    username: null,
    phoneMasked: null,
  },
  sentry: { enabled: false, recentEventIds: [] },
}

/** 固定「现在」= 2026-07-08T08:00:00.000Z */
const NOW_MS = Date.parse('2026-07-08T08:00:00.000Z')
const SINCE_MS = NOW_MS - CLIPBOARD_WINDOW_MS

describe('filterLogEntriesSince', () => {
  it('只保留门槛后的条目', () => {
    const kept = filterLogEntriesSince(
      [
        { ts: '2026-07-08T07:50:00.000Z', level: 'info', text: 'old' },
        { ts: '2026-07-08T07:56:00.000Z', level: 'error', text: 'fresh' },
      ],
      SINCE_MS,
    )
    expect(kept.map((e) => e.text)).toEqual(['fresh'])
  })
})

describe('filterMainLogTextSince', () => {
  it('按行首时间戳过滤，并保留窗内续行', () => {
    const text = [
      '[2026-07-08 07:50:00.000] [info] too-old',
      '[2026-07-08 07:56:00.000] [error] in-window',
      '  stack continuation',
      '[2026-07-08 07:57:00.000] [info] also-fresh',
    ].join('\n')
    // 行首无 Z：V8 按本地时区解析。用 ISO local 构造门槛，避免机房时区把断言打飞。
    const localInWindow = Date.parse('2026-07-08T07:56:00.000')
    const localCutoff = localInWindow - 60_000
    const out = filterMainLogTextSince(text, localCutoff)
    expect(out).toContain('in-window')
    expect(out).toContain('stack continuation')
    expect(out).toContain('also-fresh')
    expect(out).not.toContain('too-old')
  })
})

describe('filterTimedItemsSince', () => {
  it('按指定字段过滤', () => {
    const items = filterTimedItemsSince(
      [
        { timestamp: '2026-07-08T07:50:00.000Z', message: 'old' },
        { timestamp: '2026-07-08T07:58:00.000Z', message: 'new' },
      ],
      (b) => b.timestamp,
      SINCE_MS,
    )
    expect(items).toHaveLength(1)
    expect(items[0].message).toBe('new')
  })
})

describe('prepareClipboardDiagnostics', () => {
  it('组装最近时间窗内容，不含 old.log，meta 全量', () => {
    const prepared = prepareClipboardDiagnostics({
      meta: baseMeta,
      logEntries: [
        { ts: '2026-07-08T07:50:00.000Z', level: 'info', text: 'stale-renderer' },
        { ts: '2026-07-08T07:58:00.000Z', level: 'error', text: 'fresh-renderer' },
      ],
      breadcrumbs: [
        { type: 'click', category: 'ui', message: 'old-click', timestamp: '2026-07-08T07:50:00.000Z' },
        { type: 'click', category: 'ui', message: 'new-click', timestamp: '2026-07-08T07:59:00.000Z' },
      ],
      errors: [
        { occurred_at: '2026-07-08T07:50:00.000Z', message: 'old-err' },
        { occurred_at: '2026-07-08T07:59:30.000Z', message: 'new-err' },
      ],
      mainLog: (() => {
        // 用本地墙钟拼行首，与 electron-log / filter 对齐，避免时区把断言打飞
        const fmt = (ms: number) => {
          const d = new Date(ms)
          const p = (n: number) => String(n).padStart(2, '0')
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`
        }
        return [
          `[${fmt(NOW_MS - 60 * 60_000)}] [info] UpdateManager ancient`,
          `[${fmt(NOW_MS - 60_000)}] [error] LLM failed`,
        ].join('\n')
      })(),
      nowMs: NOW_MS,
      windowMs: CLIPBOARD_WINDOW_MS,
    })

    expect(prepared.rendererLog).toContain('fresh-renderer')
    expect(prepared.rendererLog).not.toContain('stale-renderer')
    expect(JSON.stringify(prepared.breadcrumbs)).toContain('new-click')
    expect(JSON.stringify(prepared.breadcrumbs)).not.toContain('old-click')
    expect(JSON.stringify(prepared.errors)).toContain('new-err')
    expect(JSON.stringify(prepared.errors)).not.toContain('old-err')
    expect(prepared.mainLog).toContain('LLM failed')
    expect(prepared.mainLog).not.toContain('UpdateManager ancient')
    expect(prepared.windowMs).toBe(CLIPBOARD_WINDOW_MS)
    expect(prepared.meta.reason).toBe('menu')
  })
})

describe('buildDiagnosticsClipboardText', () => {
  it('文案包含时间窗说明与分段', () => {
    const text = buildDiagnosticsClipboardText({
      meta: baseMeta,
      rendererLog: 'line-1',
      breadcrumbs: [{ type: 'click' }],
      errors: [],
      mainLog: null,
      mainLogNote: 'dev empty',
      windowSinceIso: '2026-07-08T07:55:00.000Z',
      windowMs: CLIPBOARD_WINDOW_MS,
    })

    expect(text).toContain('window: last 5 minute(s)')
    expect(text).toContain('## meta.json')
    expect(text).toContain('"reason": "menu"')
    expect(text).toContain('## renderer.log')
    expect(text).toContain('line-1')
    expect(text).toContain('## main.log (dev empty)')
  })

  it('truncateDiagnosticsClipboardText 超长时保留头部', () => {
    const raw = `HEAD-${'x'.repeat(200)}-tail`
    const out = truncateDiagnosticsClipboardText(raw, 50)
    expect(out).toContain('剪贴板内容已截断')
    expect(out).toContain('HEAD-')
    expect(out).not.toContain('-tail')
  })
})
