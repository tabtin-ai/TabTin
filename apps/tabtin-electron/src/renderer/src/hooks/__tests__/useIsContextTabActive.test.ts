import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { renderHook } from '@testing-library/react'
import { useContextTabScopeKey, useIsContextTabActive } from '../useIsContextTabActive'

const SPACE = 'space-aaa'
const DESKTOP_SCOPE = 'desktop:organization:org-1:user:user-1'
const CONVERSATION_SCOPE = 'conversation:session-1'

describe('useIsContextTabActive', () => {
  beforeEach(() => {
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {},
      itemsBySpace: {},
      activeKeyBySpace: {},
      displayKeyBySpace: {},
    })
  })

  it('conversation scope 下按 scope 桶判断 active，而非 raw spaceId', () => {
    const tabKey = 'tabdata:table-1'
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: { [CONVERSATION_SCOPE]: [tabKey] },
      itemsBySpace: {
        [CONVERSATION_SCOPE]: {
          [tabKey]: { tabKey, type: 'tabdata', id: 'table-1' },
        },
      },
      activeKeyBySpace: {
        [CONVERSATION_SCOPE]: tabKey,
        [SPACE]: null,
      },
      displayKeyBySpace: { [CONVERSATION_SCOPE]: tabKey },
    })

    const { result: activeResult } = renderHook(() => useIsContextTabActive(tabKey))
    expect(activeResult.current).toBe(true)

    const { result: scopeResult } = renderHook(() => useContextTabScopeKey(tabKey))
    expect(scopeResult.current).toBe(CONVERSATION_SCOPE)
  })

  it('非 active tab 返回 false', () => {
    const tabKey = 'tabdata:table-2'
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: { [CONVERSATION_SCOPE]: ['tabdata:other', tabKey] },
      activeKeyBySpace: { [CONVERSATION_SCOPE]: 'tabdata:other' },
    })

    const { result } = renderHook(() => useIsContextTabActive(tabKey))
    expect(result.current).toBe(false)
  })

  it('同 tabKey 同时位于 legacy + desktop 桶时，legacy 为 active 仍判定为 active', () => {
    const tabKey = 'tabdata:table-shared'
    // desktop 后写入（旧 reverse index last-write-wins 会指向 desktop），
    // 但其 active 是别的 tab；legacy space 才是该表的前景。
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [SPACE]: [tabKey],
        [DESKTOP_SCOPE]: [tabKey, 'tabdata:other'],
      },
      itemsBySpace: {
        [SPACE]: { [tabKey]: { tabKey, type: 'tabdata', id: 'table-shared' } },
        [DESKTOP_SCOPE]: {
          [tabKey]: { tabKey, type: 'tabdata', id: 'table-shared' },
          'tabdata:other': { tabKey: 'tabdata:other', type: 'tabdata', id: 'other' },
        },
      },
      activeKeyBySpace: {
        [SPACE]: tabKey,
        [DESKTOP_SCOPE]: 'tabdata:other',
      },
      displayKeyBySpace: {
        [SPACE]: tabKey,
        [DESKTOP_SCOPE]: 'tabdata:other',
      },
    })

    const { result: activeResult } = renderHook(() => useIsContextTabActive(tabKey))
    expect(activeResult.current).toBe(true)

    // scope 解析优先返回 active 命中的桶（legacy）
    const { result: scopeResult } = renderHook(() => useContextTabScopeKey(tabKey))
    expect(scopeResult.current).toBe(SPACE)
  })

  it('同 tabKey 位于 legacy + conversation 桶时，conversation 为 active 则判定为 active', () => {
    const tabKey = 'tabdata:table-shared'
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [SPACE]: [tabKey, 'tabdata:other'],
        [CONVERSATION_SCOPE]: [tabKey],
      },
      activeKeyBySpace: {
        [SPACE]: 'tabdata:other',
        [CONVERSATION_SCOPE]: tabKey,
      },
      displayKeyBySpace: {
        [SPACE]: 'tabdata:other',
        [CONVERSATION_SCOPE]: tabKey,
      },
    })

    const { result: activeResult } = renderHook(() => useIsContextTabActive(tabKey))
    expect(activeResult.current).toBe(true)

    const { result: scopeResult } = renderHook(() => useContextTabScopeKey(tabKey))
    expect(scopeResult.current).toBe(CONVERSATION_SCOPE)
  })

  it('多桶均未激活该 tab 时返回 false', () => {
    const tabKey = 'tabdata:table-shared'
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [SPACE]: [tabKey],
        [DESKTOP_SCOPE]: [tabKey],
      },
      activeKeyBySpace: {
        [SPACE]: 'tabdata:other',
        [DESKTOP_SCOPE]: 'tabdata:other',
      },
    })

    const { result } = renderHook(() => useIsContextTabActive(tabKey))
    expect(result.current).toBe(false)
  })
})
