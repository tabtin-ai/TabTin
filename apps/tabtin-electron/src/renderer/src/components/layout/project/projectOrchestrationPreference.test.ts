import { afterEach, describe, expect, it } from 'vitest'
import {
  readProjectOrchestrationCollapsed,
  writeProjectOrchestrationCollapsed,
} from './projectOrchestrationPreference'

describe('Project AI 编排折叠偏好', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('没有已存偏好时默认折叠', () => {
    expect(readProjectOrchestrationCollapsed('user-a')).toBe(true)
  })

  it('按用户保存并恢复展开或折叠状态', () => {
    writeProjectOrchestrationCollapsed('user-a', false)
    writeProjectOrchestrationCollapsed('user-b', true)

    expect(readProjectOrchestrationCollapsed('user-a')).toBe(false)
    expect(readProjectOrchestrationCollapsed('user-b')).toBe(true)
  })
})
