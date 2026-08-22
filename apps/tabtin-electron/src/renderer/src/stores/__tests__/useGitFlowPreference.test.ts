import { beforeEach, describe, expect, it } from 'vitest'
import { useGitFlowPreference } from '../useGitFlowPreference'

describe('useGitFlowPreference', () => {
  beforeEach(() => {
    useGitFlowPreference.setState({ hiddenByPath: {} })
  })

  it('默认未隐藏 Git 流程模式', () => {
    expect(useGitFlowPreference.getState().isGitFlowHidden('/Users/me/project')).toBe(false)
  })

  it('关闭后按目录记住，重新打开后清除记录', () => {
    const { setGitFlowHidden, isGitFlowHidden } = useGitFlowPreference.getState()

    setGitFlowHidden('/Users/me/project', true)
    expect(isGitFlowHidden('/Users/me/project')).toBe(true)

    setGitFlowHidden('/Users/me/project', false)
    expect(isGitFlowHidden('/Users/me/project')).toBe(false)
    expect(useGitFlowPreference.getState().hiddenByPath).toEqual({})
  })

  it('按 normalizeComparableKey 归一化——不同写法的同一路径共享偏好', () => {
    const { setGitFlowHidden, isGitFlowHidden } = useGitFlowPreference.getState()

    setGitFlowHidden('/Users/me/project/', true)
    expect(isGitFlowHidden('/Users/me/project')).toBe(true)
  })

  it('不同目录的偏好互不影响', () => {
    const { setGitFlowHidden, isGitFlowHidden } = useGitFlowPreference.getState()

    setGitFlowHidden('/Users/me/project-a', true)
    expect(isGitFlowHidden('/Users/me/project-a')).toBe(true)
    expect(isGitFlowHidden('/Users/me/project-b')).toBe(false)
  })

  it('空路径不写入偏好', () => {
    const { setGitFlowHidden, isGitFlowHidden } = useGitFlowPreference.getState()

    setGitFlowHidden('', true)
    expect(isGitFlowHidden('')).toBe(false)
    expect(useGitFlowPreference.getState().hiddenByPath).toEqual({})
  })
})
