/**
 * subagent-session.test.tsx — PRD §4.1.1 / §4.3 / §4.10 / 红线 #7 回归
 *
 * 锁定 subagent_session handler 契约：
 *   1. 注册成功 + getAppId fallback 到 type 本身（红线 #7：不声明 appId）
 *   2. 不出现在 Agent-facing apps、quickAction、@提及、AppList
 *   3. isVisibleInContext 各分支：
 *      - currentSessionId === parentSessionId → true
 *      - currentSessionId !== parentSessionId → false（隐藏不删）
 *      - currentSessionId == null（首页 / 草稿）→ false
 *      - meta.parentSessionId 缺失 → false（防 orphan）
 *      - type !== subagent_session → true（不干扰其他 tab）
 *   4. beforeClose：
 *      - running / queued / pending → 弹确认对话框
 *      - completed / failed / cancelled / unknown → 直接放行不弹
 *      - meta.parentSessionId 缺失 → 直接放行
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../chat/subagent/SubagentDetailPane', () => ({
  SubagentDetailPane: () => null,
}))

const requestSpy = vi.fn()
vi.mock('../../../../chat/subagent/subagentTabCloseConfirm', () => ({
  requestSubagentTabCloseConfirm: (name: string) => requestSpy(name),
}))

import { contextRegistry } from '../../index'
import { subagentSessionHandler } from '../subagent-session'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import type { ContextItem } from '../../types'

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    type: 'subagent_session',
    id: 'run-1',
    tabKey: 'subagent_session:run-1',
    title: 'Subagent 1',
    meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
    ...overrides,
  }
}

beforeEach(() => {
  requestSpy.mockReset()
})

afterEach(() => {
  useChatRuntimeStore.setState({ subagentRunsBySessionId: {} } as never)
})

describe('subagent-session handler 注册 + Agent 元信息', () => {
  it('已注册到 contextRegistry，handler.type === "subagent_session"', () => {
    const handler = contextRegistry.getHandler('subagent_session')
    expect(handler).toBeDefined()
    expect(handler).toBe(subagentSessionHandler)
  })

  it('红线 #7：不声明 appId / backendAliases / quickAction / mention / appEntryMode / agent', () => {
    expect(subagentSessionHandler.appId).toBeUndefined()
    expect(subagentSessionHandler.backendAliases).toBeUndefined()
    expect(subagentSessionHandler.quickAction).toBeUndefined()
    expect(subagentSessionHandler.mention).toBeUndefined()
    expect(subagentSessionHandler.appEntryMode).toBeUndefined()
    expect(subagentSessionHandler.agent).toBeUndefined()
  })

  it('getAppId(subagent_session) 返回 undefined（handler 未声明 appId，不与真 App 抢身份）', () => {
    // PRD §4.1.1 / 红线 #7：刻意不声明 appId，避免污染 appIdIndex
    // 注：register 内部仍会按 type 自动入 appIdIndex 做反查（这是 registry 通用兜底），
    // 但 getAppId 走 handler.appId 字段，未声明就是 undefined——LLM-facing 入口（`<apps>`）
    // 走 getAgentExposedHandlers，本 handler 不在其中。
    const appId = contextRegistry.getAppId('subagent_session')
    expect(appId).toBeUndefined()
  })

  it('不出现在 Agent-exposed handlers（不进 <apps> 段、不被 LLM 视作真 App）', () => {
    const exposed = contextRegistry.getAgentExposedHandlers().map(h => h.type as string)
    expect(exposed).not.toContain('subagent_session')
  })

  it('renderMode pane + keepAlive + persistOnly + closable', () => {
    expect(subagentSessionHandler.renderMode).toBe('pane')
    expect(subagentSessionHandler.keepAlive).toBe(true)
    expect(subagentSessionHandler.persistOnly).toBe(true)
    expect(subagentSessionHandler.closable).toBe(true)
  })
})

describe('subagent-session.isVisibleInContext', () => {
  const visible = subagentSessionHandler.isVisibleInContext!

  it('parentSessionId === currentSessionId → true', () => {
    expect(visible(makeItem(), { spaceId: 'sp', currentSessionId: 'sess-a' })).toBe(true)
  })

  it('parentSessionId !== currentSessionId → false（隐藏，不删）', () => {
    expect(visible(makeItem(), { spaceId: 'sp', currentSessionId: 'sess-b' })).toBe(false)
  })

  it('currentSessionId === null（首页 / 草稿）→ false 全部隐藏', () => {
    expect(visible(makeItem(), { spaceId: 'sp', currentSessionId: null })).toBe(false)
  })

  it('meta.parentSessionId 缺失（脏数据 / 老格式）→ false 隐藏', () => {
    const bad = makeItem({ meta: { kind: 'subagent_session' } as Record<string, unknown> })
    expect(visible(bad, { spaceId: 'sp', currentSessionId: 'sess-a' })).toBe(false)
  })

  it('type !== subagent_session（混入其他 tab 时）→ true 直通', () => {
    const other = makeItem({ type: 'tabdata', tabKey: 'tabdata:t1' })
    expect(visible(other, { spaceId: 'sp', currentSessionId: 'sess-a' })).toBe(true)
  })
})

describe('subagent-session.beforeClose', () => {
  const beforeClose = subagentSessionHandler.beforeClose!
  const ctx = { spaceId: 'sp', closeBrowserView: vi.fn() } as never

  it('running 态 → 弹确认对话框，用户选 close 时返回 true', async () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { 'sess-a': [{ subagentRunId: 'run-1', status: 'running' } as never] },
    } as never)
    requestSpy.mockResolvedValueOnce('close')

    const allowed = await beforeClose(makeItem(), ctx)

    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(allowed).toBe(true)
  })

  it('running 态 → 用户选 keep 时返回 false（保留标签）', async () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { 'sess-a': [{ subagentRunId: 'run-1', status: 'running' } as never] },
    } as never)
    requestSpy.mockResolvedValueOnce('keep')

    expect(await beforeClose(makeItem(), ctx)).toBe(false)
  })

  it('queued 态 → 仍弹确认', async () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { 'sess-a': [{ subagentRunId: 'run-1', status: 'queued' } as never] },
    } as never)
    requestSpy.mockResolvedValueOnce('close')

    await beforeClose(makeItem(), ctx)
    expect(requestSpy).toHaveBeenCalledTimes(1)
  })

  it('pending 态 → 仍弹确认', async () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { 'sess-a': [{ subagentRunId: 'run-1', status: 'pending' } as never] },
    } as never)
    requestSpy.mockResolvedValueOnce('close')

    await beforeClose(makeItem(), ctx)
    expect(requestSpy).toHaveBeenCalledTimes(1)
  })

  for (const terminal of ['completed', 'failed', 'cancelled', 'unknown'] as const) {
    it(`${terminal} 态 → 直接放行不弹`, async () => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: { 'sess-a': [{ subagentRunId: 'run-1', status: terminal } as never] },
      } as never)

      const allowed = await beforeClose(makeItem(), ctx)
      expect(allowed).toBe(true)
      expect(requestSpy).not.toHaveBeenCalled()
    })
  }

  it('run 不在 store（未找到）→ 直接放行不弹', async () => {
    useChatRuntimeStore.setState({ subagentRunsBySessionId: {} } as never)

    const allowed = await beforeClose(makeItem(), ctx)
    expect(allowed).toBe(true)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('meta.parentSessionId 缺失 → 直接放行（不弹、不查 store）', async () => {
    const allowed = await beforeClose(makeItem({ meta: undefined }), ctx)
    expect(allowed).toBe(true)
    expect(requestSpy).not.toHaveBeenCalled()
  })
})
