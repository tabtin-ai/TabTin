/**
 * Wave 3.2 复核加固：useWorkbenchSceneStore 的 removeFromHot / clearAllScenes 行为测试。
 *
 * 这两个方法是必修 1 的核心：onSpaceDeleted / 切账号路径必须有「真离开 → 同步剔除
 * hot」的闭环，否则 useRunManager 的 cleanup 守卫看到 stale hot 会错误保活 Run。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  useWorkbenchSceneStore,
  toWorkbenchSceneId,
} from '../useWorkbenchSceneStore'

describe('useWorkbenchSceneStore.removeFromHot', () => {
  beforeEach(() => {
    useWorkbenchSceneStore.setState({
      foregroundSceneId: null,
      hotSceneIds: [],
    })
  })

  afterEach(() => {
    useWorkbenchSceneStore.setState({
      foregroundSceneId: null,
      hotSceneIds: [],
    })
  })

  it('从 hot 集合中剔除指定 sceneId（其他 sceneId 保留）', () => {
    const { activateForegroundSpace, removeFromHot } = useWorkbenchSceneStore.getState()
    activateForegroundSpace('A')
    activateForegroundSpace('B')
    activateForegroundSpace('C')
    expect(useWorkbenchSceneStore.getState().hotSceneIds).toEqual([
      toWorkbenchSceneId('A'),
      toWorkbenchSceneId('B'),
      toWorkbenchSceneId('C'),
    ])

    removeFromHot(toWorkbenchSceneId('B'))

    expect(useWorkbenchSceneStore.getState().hotSceneIds).toEqual([
      toWorkbenchSceneId('A'),
      toWorkbenchSceneId('C'),
    ])
  })

  it('剔除当前 foregroundSceneId 时同步清 foreground（避免 stale 指向已删 Space）', () => {
    const { activateForegroundSpace, removeFromHot } = useWorkbenchSceneStore.getState()
    activateForegroundSpace('A')
    expect(useWorkbenchSceneStore.getState().foregroundSceneId).toBe(toWorkbenchSceneId('A'))

    removeFromHot(toWorkbenchSceneId('A'))

    expect(useWorkbenchSceneStore.getState().foregroundSceneId).toBeNull()
    expect(useWorkbenchSceneStore.getState().hotSceneIds).toEqual([])
  })

  it('剔除非 foreground 的 hot sceneId 时不动 foreground', () => {
    const { activateForegroundSpace, removeFromHot } = useWorkbenchSceneStore.getState()
    activateForegroundSpace('A')
    activateForegroundSpace('B') // ← B 是 foreground
    removeFromHot(toWorkbenchSceneId('A'))

    const { foregroundSceneId, hotSceneIds } = useWorkbenchSceneStore.getState()
    expect(foregroundSceneId).toBe(toWorkbenchSceneId('B'))
    expect(hotSceneIds).toEqual([toWorkbenchSceneId('B')])
  })

  it('剔除不存在的 sceneId 是 no-op（state 引用不变）', () => {
    const { activateForegroundSpace, removeFromHot } = useWorkbenchSceneStore.getState()
    activateForegroundSpace('A')
    const before = useWorkbenchSceneStore.getState()

    removeFromHot(toWorkbenchSceneId('Z'))

    const after = useWorkbenchSceneStore.getState()
    expect(after).toBe(before)
  })

  it('剔除 hot 但不是 foreground 的某个 sceneId 后 getSceneActivity 返 background-cold', () => {
    const { activateForegroundSpace, removeFromHot, getSceneActivity } = useWorkbenchSceneStore.getState()
    activateForegroundSpace('A')
    activateForegroundSpace('B')
    expect(getSceneActivity(toWorkbenchSceneId('A'))).toBe('background-hot')

    removeFromHot(toWorkbenchSceneId('A'))

    expect(useWorkbenchSceneStore.getState().getSceneActivity(toWorkbenchSceneId('A'))).toBe('background-cold')
  })
})

describe('useWorkbenchSceneStore.clearAllScenes', () => {
  beforeEach(() => {
    useWorkbenchSceneStore.setState({
      foregroundSceneId: null,
      hotSceneIds: [],
    })
  })

  it('完全清空 foreground + hot（登出 / sessionReset 路径）', () => {
    const { activateForegroundSpace, clearAllScenes } = useWorkbenchSceneStore.getState()
    activateForegroundSpace('A')
    activateForegroundSpace('B')
    activateForegroundSpace('C')

    clearAllScenes()

    const { foregroundSceneId, hotSceneIds } = useWorkbenchSceneStore.getState()
    expect(foregroundSceneId).toBeNull()
    expect(hotSceneIds).toEqual([])
  })
})
