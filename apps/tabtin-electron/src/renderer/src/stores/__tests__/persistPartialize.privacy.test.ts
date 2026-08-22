/**
 * persistPartialize.privacy.test.ts — PRD §4.16 / 红线 #9 / 隐私验收
 *
 * 锁定持久化层对 subagent_session.meta.task 的剥离契约：
 *   - persist 阶段把 subagent_session item 的 meta.task 字段去掉
 *   - 同时保留 parentSessionId / parentToolCallId / label / speakerId 这些 restore 必需字段
 *   - 其它类型的 tab 不受影响（不要误杀 tabweb 等的 meta）
 *
 * 实测方式：直接调用 store 内部的 partialize（zustand 把它挂在 persist 配置上）。
 * 由于 partialize 是闭包内私有，这里通过触发一次 persist（manual setState 后强制
 * persist），用 setItem 拦截读出实际写入字符串，再反序列化校验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useSpaceContextTabsStore } from '../useSpaceContextTabsStore'
import { PERSIST_KEYS } from '../persist-key-registry'

const SPACE = 'space-privacy'

function resetStore() {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
  })
}

function readPersistedState(): {
  itemsBySpace: Record<string, Record<string, { type: string; meta?: Record<string, unknown> }>>
} | null {
  const raw = localStorage.getItem(PERSIST_KEYS.contextTabs)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed?.state ?? null
  } catch {
    return null
  }
}

beforeEach(() => {
  resetStore()
  localStorage.removeItem(PERSIST_KEYS.contextTabs)
})

describe('persist partialize：subagent_session.meta.task 隐私剥离', () => {
  it('subagent_session tab persist 后 meta.task 被剥离，其他字段保留', async () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-secret',
      title: 'work on prompt',
      meta: {
        kind: 'subagent_session',
        parentSessionId: 'sess-1',
        parentToolCallId: 'toolcall-x',
        label: 'work',
        task: '用户的敏感 prompt 内容不应该写到 localStorage',
        speakerId: 'speaker-a',
      },
    })

    // 强制触发 persist 写盘
    await useSpaceContextTabsStore.persist.rehydrate?.()
    // setState 触发本身就会异步 persist；这里给一个 microtask 让 persist flush
    await Promise.resolve()
    await Promise.resolve()

    const persisted = readPersistedState()
    const item = persisted?.itemsBySpace?.[SPACE]?.['subagent_session:run-secret']
    expect(item).toBeDefined()
    expect(item?.meta).toBeDefined()
    // task 必须不在
    expect(Object.keys(item!.meta!)).not.toContain('task')
    // 其他字段必须在
    expect(item!.meta!.parentSessionId).toBe('sess-1')
    expect(item!.meta!.parentToolCallId).toBe('toolcall-x')
    expect(item!.meta!.label).toBe('work')
    expect(item!.meta!.speakerId).toBe('speaker-a')
  })

  it('非 subagent_session tab 的 meta 不被剥离（不要误伤 tabweb 等）', async () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'tabweb',
      id: 'view-1',
      title: 'some page',
      meta: { url: 'https://example.com', task: 'task-ish but tabweb 用得到' },
    })

    await Promise.resolve()
    await Promise.resolve()

    const persisted = readPersistedState()
    const item = persisted?.itemsBySpace?.[SPACE]?.['tabweb:view-1']
    expect(item?.meta?.url).toBe('https://example.com')
    expect(item?.meta?.task).toBe('task-ish but tabweb 用得到')
  })

  it('多 space 多 tab：subagent_session 全部剥 task，其他类型完整保留', async () => {
    useSpaceContextTabsStore.getState().openResourceTab('space-a', {
      type: 'subagent_session',
      id: 'r1',
      title: 'r1',
      meta: { kind: 'subagent_session', parentSessionId: 'sa', task: 'secret-1' },
    })
    useSpaceContextTabsStore.getState().openResourceTab('space-a', {
      type: 'subagent_session',
      id: 'r2',
      title: 'r2',
      meta: { kind: 'subagent_session', parentSessionId: 'sa', task: 'secret-2' },
    })
    useSpaceContextTabsStore.getState().openResourceTab('space-b', {
      type: 'subagent_session',
      id: 'r3',
      title: 'r3',
      meta: { kind: 'subagent_session', parentSessionId: 'sb', task: 'secret-3' },
    })
    useSpaceContextTabsStore.getState().openResourceTab('space-b', {
      type: 'tabdoc',
      id: 'doc-1',
      meta: { task: 'tabdoc 字段，留着' },
    })

    await Promise.resolve()
    await Promise.resolve()

    const persisted = readPersistedState()
    expect(persisted?.itemsBySpace?.['space-a']?.['subagent_session:r1']?.meta?.task).toBeUndefined()
    expect(persisted?.itemsBySpace?.['space-a']?.['subagent_session:r2']?.meta?.task).toBeUndefined()
    expect(persisted?.itemsBySpace?.['space-b']?.['subagent_session:r3']?.meta?.task).toBeUndefined()
    // tabdoc 的 task 字段被保留
    expect(persisted?.itemsBySpace?.['space-b']?.['tabdoc:doc-1']?.meta?.task).toBe('tabdoc 字段，留着')
  })
})
