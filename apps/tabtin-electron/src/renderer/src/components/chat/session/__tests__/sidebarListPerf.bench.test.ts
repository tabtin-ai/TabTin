/**
 * 方案 C 预处理回归微基准（ 次要路径）。
 *
 * 测 filter + sort + buildSessionListVirtualItems 的 CPU，不是流式卡顿主因
 * （主因是 messages 宽订阅 → React commit；须用 Profiler live 验收）。
 *
 * 复跑见 docs/agent/8878-sidebar-decouple-messages-acceptance-harness.md
 */
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { sortSessionsByActivity } from '@/utils/chat-session-sort'
import { buildSessionListVirtualItems } from '../buildSessionListVirtualItems'
import { filterSidebarSessions } from '../filterSidebarSessions'

function makeSession(i: number, spaceId: string): ChatSession {
  const ts = new Date(Date.now() - i * 60_000).toISOString()
  return {
    id: `session-${i}`,
    title: `会话 ${i}`,
    space_id: spaceId,
    status: 'active',
    message_count: i % 7 === 0 ? 0 : 3,
    created_at: ts,
    updated_at: ts,
    last_message_at: ts,
  } as ChatSession
}

function measureMs(fn: () => void, iterations: number): number {
  for (let i = 0; i < 3; i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - start) / iterations
}

describe('sidebar list prep cost (perf harness)', () => {
  it('quantifies cascade cost vs session count', () => {
    const workspaceCount = 10
    const spaceNameById = Object.fromEntries(
      Array.from({ length: workspaceCount }, (_, i) => [`space-${i}`, `工作空间 ${i}`]),
    )
    const iterations = 25
    const sizes = [50, 200, 500] as const
    const results: Record<number, number> = {}

    for (const n of sizes) {
      const sessions = Array.from({ length: n }, (_, i) =>
        makeSession(i, `space-${i % workspaceCount}`),
      )
      results[n] = measureMs(() => {
        const keepAlive = new Set<string>()
        const filtered = filterSidebarSessions(sessions, null, keepAlive)
        const sorted = sortSessionsByActivity(filtered)
        buildSessionListVirtualItems({
          sortedSessions: sorted,
          groupLabels: {
            pinned: '置顶',
            trackerRuns: '自动化',
            today: '今天',
            yesterday: '昨天',
            recent7d: '最近 7 天',
            recent30d: '最近 30 天',
            older: '更早',
          },
          collapsedGroups: new Set(),
          spaceNameById,
          workspaceListSortMode: 'activity',
          getSessionSpaceId: (session) => session.space_id ?? 'space-0',
          getSessionSpaceLabel: (id) => spaceNameById[id] ?? id,
          listContent: 'sessions',
        })
      }, iterations)
    }

    console.log('[sidebar-perf]', { avgMs: results })
    // 半帧预算：预处理本身不应打穿；缩放比受机器噪声影响，只打日志不硬断言
    expect(results[200]).toBeLessThan(8)
  })
})
