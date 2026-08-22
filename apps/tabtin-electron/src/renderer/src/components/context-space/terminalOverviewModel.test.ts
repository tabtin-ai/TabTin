import { describe, it, expect } from 'vitest'
import { buildTerminalOverview, resolveSessionRunState } from './terminalOverviewModel'
import { CLOSED_SESSION_TTL_MS, MAX_CLOSED_PER_SPACE, type TerminalSession } from './sources/terminal'
import type { PaneStatus } from '@stores/useTerminalPaneStatusStore'

const now = Date.now()

function session(over: Partial<TerminalSession> & { id: string; spaceId: string }): TerminalSession {
  return {
    title: over.id,
    createdAt: now,
    source: 'user',
    status: 'active',
    ...over,
  }
}

/** 把若干 sessionId 标成真实进程态（默认 running），喂给 buildTerminalOverview */
function panes(ids: string[], status: PaneStatus = 'running'): Record<string, PaneStatus> {
  return Object.fromEntries(ids.map((id) => [id, status]))
}

describe('resolveSessionRunState', () => {
  it('R3 P1-3：生命周期 closed 压过残留 paneStatus running（一键停后立刻已结束）', () => {
    // active + running 仍算运行中；但 closed 已是本地确定的终态，应压过可能残留的
    // running（主进程 kill 后总览收不到 exited 的场景），避免徽标卡「运行中」。
    expect(resolveSessionRunState({ status: 'active' }, 'running')).toBe('running')
    expect(resolveSessionRunState({ status: 'closed' }, 'running')).toBe('exited')
  })

  it('paneStatus===exited → 已结束', () => {
    expect(resolveSessionRunState({ status: 'active' }, 'exited')).toBe('exited')
  })

  it('生命周期 closed（无/idle 进程态）→ 已结束', () => {
    expect(resolveSessionRunState({ status: 'closed' }, undefined)).toBe('exited')
    expect(resolveSessionRunState({ status: 'closed' }, 'idle')).toBe('exited')
  })

  it('idle 的 shell 与无真实进程态的 active 会话 → 空闲（绝不假运行）', () => {
    expect(resolveSessionRunState({ status: 'active' }, 'idle')).toBe('idle')
    expect(resolveSessionRunState({ status: 'active' }, undefined)).toBe('idle')
  })
})

describe('buildTerminalOverview', () => {
  it('空输入返回空总览', () => {
    const ov = buildTerminalOverview({ sessionsBySpace: {}, transcriptsById: {}, spaceMeta: {}, selectedSpaceId: null, paneStatusById: {} })
    expect(ov.groups).toEqual([])
    expect(ov.totalCount).toBe(0)
    expect(ov.runningCount).toBe(0)
    expect(ov.runStateById).toEqual({})
    expect(ov.stoppableById).toEqual({})
  })

  it('跨 Space 聚合并把本 Agent（当前 active spaceId）置顶', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-a': [session({ id: 'a1', spaceId: 'space-a' })],
        'space-b': [session({ id: 'b1', spaceId: 'space-b' })],
      },
      transcriptsById: {},
      spaceMeta: { 'space-a': { name: 'Agent A' }, 'space-b': { name: 'Agent B' } },
      selectedSpaceId: 'space-b',
      paneStatusById: {},
    })
    expect(ov.groups.map(g => g.spaceId)).toEqual(['space-b', 'space-a'])
    expect(ov.groups[0].isCurrent).toBe(true)
    expect(ov.groups[0].agentName).toBe('Agent B')
    expect(ov.totalCount).toBe(2)
  })

  it('隐藏 agent transcript 不进入侧边栏（仅 sessionsBySpace 展示）', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {},
      transcriptsById: {
        't1': session({ id: 'agent-x', spaceId: 'space-a', source: 'agent', title: 'pnpm dev' }),
      },
      spaceMeta: { 'space-a': { name: 'Agent A' } },
      selectedSpaceId: 'space-a',
      paneStatusById: panes(['agent-x']),
    })
    expect(ov.groups).toHaveLength(0)
    expect(ov.totalCount).toBe(0)
  })

  it('已 materialize 的 agent 会话在列表中；结束后从侧边栏移除', () => {
    const active = session({ id: 'agent-open', spaceId: 'space-a', source: 'agent', title: 'pnpm dev' })
    const ended = session({
      id: 'agent-done',
      spaceId: 'space-a',
      source: 'agent',
      title: 'ls',
      status: 'closed',
      closedAt: now,
    })
    const ov = buildTerminalOverview({
      sessionsBySpace: { 'space-a': [active, ended] },
      transcriptsById: {},
      spaceMeta: { 'space-a': { name: 'Agent A' } },
      selectedSpaceId: 'space-a',
      paneStatusById: panes(['agent-open']),
    })
    expect(ov.groups[0].sessions.map(s => s.id)).toEqual(['agent-open'])
  })

  it('transcriptsById 不补充 sessionsBySpace 未登记的会话', () => {
    const persisted = session({ id: 'dup', spaceId: 'space-a', title: 'persisted' })
    const transcript = session({ id: 'other', spaceId: 'space-a', title: 'transcript', source: 'agent' })
    const ov = buildTerminalOverview({
      sessionsBySpace: { 'space-a': [persisted] },
      transcriptsById: { 't': transcript },
      spaceMeta: {},
      selectedSpaceId: null,
      paneStatusById: {},
    })
    expect(ov.groups[0].sessions.map(s => s.id)).toEqual(['dup'])
  })

  it('丢弃超 7 天 TTL 的 closed 会话，active 永远保留', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-a': [
          session({ id: 'live', spaceId: 'space-a', status: 'active' }),
          session({ id: 'recent-closed', spaceId: 'space-a', status: 'closed', closedAt: now - 1000 }),
          session({ id: 'stale-closed', spaceId: 'space-a', status: 'closed', closedAt: now - CLOSED_SESSION_TTL_MS - 1000 }),
        ],
      },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: null,
      paneStatusById: {},
    })
    const ids = ov.groups[0].sessions.map(s => s.id)
    expect(ids).toContain('live')
    expect(ids).toContain('recent-closed')
    expect(ids).not.toContain('stale-closed')
  })

  it('closed 超每 Space 50 条上限时只保留最近的 50 条', () => {
    const closed = Array.from({ length: 60 }, (_, i) =>
      session({ id: `c${i}`, spaceId: 'space-a', status: 'closed', closedAt: now - i * 1000 }),
    )
    const ov = buildTerminalOverview({
      sessionsBySpace: { 'space-a': [session({ id: 'live', spaceId: 'space-a' }), ...closed] },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: null,
      paneStatusById: {},
    })
    const sessions = ov.groups[0].sessions
    const closedKept = sessions.filter(s => s.status === 'closed')
    expect(closedKept).toHaveLength(MAX_CLOSED_PER_SPACE)
    // 最近的（closedAt 最大 = c0）保留，最旧的（c59）被裁掉
    expect(sessions.map(s => s.id)).toContain('c0')
    expect(sessions.map(s => s.id)).not.toContain('c59')
  })

  it('组内排序：运行中（paneStatus running）在前，同档内按 createdAt 倒序', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-a': [
          session({ id: 'old-active', spaceId: 'space-a', status: 'active', createdAt: now - 5000 }),
          session({ id: 'new-active', spaceId: 'space-a', status: 'active', createdAt: now }),
          session({ id: 'closed', spaceId: 'space-a', status: 'closed', closedAt: now }),
        ],
      },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: null,
      paneStatusById: panes(['new-active', 'old-active']),
    })
    expect(ov.groups[0].sessions.map(s => s.id)).toEqual(['new-active', 'old-active', 'closed'])
    expect(ov.groups[0].runningCount).toBe(2)
  })

  it('非当前 Agent 之间按运行中数降序排列', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-cur': [session({ id: 'cur', spaceId: 'space-cur', status: 'active' })],
        'space-few': [session({ id: 'f1', spaceId: 'space-few', status: 'active' })],
        'space-many': [
          session({ id: 'm1', spaceId: 'space-many', status: 'active' }),
          session({ id: 'm2', spaceId: 'space-many', status: 'active' }),
        ],
      },
      transcriptsById: {},
      spaceMeta: {
        'space-cur': { name: 'Cur' },
        'space-few': { name: 'Few' },
        'space-many': { name: 'Many' },
      },
      selectedSpaceId: 'space-cur',
      paneStatusById: panes(['cur', 'f1', 'm1', 'm2']),
    })
    // 当前置顶，其余按运行中数降序：many(2) 在 few(1) 前
    expect(ov.groups.map(g => g.spaceId)).toEqual(['space-cur', 'space-many', 'space-few'])
  })

  it('未知 Agent（无 spaceMeta）时 agentName 留空，由 UI 兜底', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: { 'ghost-space': [session({ id: 'g1', spaceId: 'ghost-space' })] },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: null,
      paneStatusById: {},
    })
    expect(ov.groups[0].agentName).toBe('')
  })

  it('Phase4b：scope 桶终端归入 Desktop 或 execution Space 组', () => {
    const desktopSession = session({
      id: 'desktop-terminal',
      spaceId: 'desktop:organization:wt:user:u1',
    })
    const conversationSession = session({
      id: 'conversation-terminal',
      spaceId: 'conversation:session-1',
      executionSpaceId: 'space-a',
    })

    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'desktop:organization:wt:user:u1': [desktopSession],
        'conversation:session-1': [conversationSession],
      },
      transcriptsById: {},
      spaceMeta: { 'space-a': { name: 'Agent A' } },
      selectedSpaceId: 'space-a',
      paneStatusById: {},
    })

    expect(ov.groups.map(g => g.spaceId)).toEqual(['space-a', '__desktop_terminal__'])
    expect(ov.groups[0].sessions.map(s => s.id)).toEqual(['conversation-terminal'])
    expect(ov.groups[1].isDesktop).toBe(true)
    expect(ov.groups[1].agentName).toBe('Desktop')
    expect(ov.groups[1].sessions.map(s => s.id)).toEqual(['desktop-terminal'])
  })

  it('runningCount 汇总仅统计 paneStatus===running 的会话', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-a': [session({ id: 'a1', spaceId: 'space-a', status: 'active' })],
        'space-b': [
          session({ id: 'b1', spaceId: 'space-b', status: 'active' }),
          session({ id: 'b2', spaceId: 'space-b', status: 'closed', closedAt: now }),
        ],
      },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: 'space-a',
      paneStatusById: panes(['a1', 'b1']),
    })
    expect(ov.runningCount).toBe(2)
    expect(ov.totalCount).toBe(3)
  })

  it('B1：idle 进程态的 active 会话标空闲、不计入 runningCount（治假运行）', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-a': [
          session({ id: 'idle-shell', spaceId: 'space-a', status: 'active' }),
          session({ id: 'really-running', spaceId: 'space-a', status: 'active' }),
        ],
      },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: 'space-a',
      paneStatusById: { 'idle-shell': 'idle', 'really-running': 'running' },
    })
    expect(ov.runStateById['idle-shell']).toBe('idle')
    expect(ov.runStateById['really-running']).toBe('running')
    expect(ov.runningCount).toBe(1)
  })

  it('B1：exited 进程态的 active 会话标已结束、不计入 runningCount', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: { 'space-a': [session({ id: 'done', spaceId: 'space-a', status: 'active' })] },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: 'space-a',
      paneStatusById: { done: 'exited' },
    })
    expect(ov.runStateById['done']).toBe('exited')
    expect(ov.runningCount).toBe(0)
  })

  it('B3：stoppableById —— 本机有 pane 条目且未结束 → 可停；无条目/已结束 → 不可停', () => {
    const ov = buildTerminalOverview({
      sessionsBySpace: {
        'space-a': [
          session({ id: 'local-running', spaceId: 'space-a', status: 'active' }),
          session({ id: 'local-idle', spaceId: 'space-a', status: 'active' }),
          session({ id: 'local-exited', spaceId: 'space-a', status: 'active' }),
          session({ id: 'remote-active', spaceId: 'space-a', status: 'active' }),
        ],
      },
      transcriptsById: {},
      spaceMeta: {},
      selectedSpaceId: 'space-a',
      paneStatusById: { 'local-running': 'running', 'local-idle': 'idle', 'local-exited': 'exited' },
    })
    expect(ov.stoppableById['local-running']).toBe(true)
    expect(ov.stoppableById['local-idle']).toBe(true)
    expect(ov.stoppableById['local-exited']).toBe(false)
    // 无本机 pane 条目（远程/未知）→ 不可本机停（与设备徽标解耦）
    expect(ov.stoppableById['remote-active']).toBe(false)
  })
})
