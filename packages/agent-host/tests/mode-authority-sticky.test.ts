import { describe, expect, it } from 'vitest'
import {
  isShellRestrictedAgentMode,
  resolveRuntimeModeAgainstSticky,
} from '../src/runtime/mode-authority-sticky.js'

describe('mode-authority-sticky ', () => {
  it('识别 shell 受限模式', () => {
    expect(isShellRestrictedAgentMode('plan')).toBe(true)
    expect(isShellRestrictedAgentMode('ask')).toBe(true)
    expect(isShellRestrictedAgentMode('study')).toBe(true)
    expect(isShellRestrictedAgentMode('agent')).toBe(false)
    expect(isShellRestrictedAgentMode('group')).toBe(false)
    expect(isShellRestrictedAgentMode('yolo')).toBe(false)
  })

  it('sticky=agent 时挡住陈旧 plan/ask/study IPC', () => {
    expect(resolveRuntimeModeAgainstSticky('plan', 'agent')).toBe('agent')
    expect(resolveRuntimeModeAgainstSticky('ask', 'agent')).toBe('agent')
    expect(resolveRuntimeModeAgainstSticky('study', 'group')).toBe('group')
  })

  it('请求已是非受限模式时不覆盖', () => {
    expect(resolveRuntimeModeAgainstSticky('agent', 'agent')).toBe('agent')
    expect(resolveRuntimeModeAgainstSticky('group', 'agent')).toBe('group')
  })

  it('用户主动 sticky=plan 后允许回到 plan', () => {
    expect(resolveRuntimeModeAgainstSticky('plan', 'plan')).toBe('plan')
    expect(resolveRuntimeModeAgainstSticky('ask', 'plan')).toBe('ask')
  })

  it('无 sticky 时原样返回', () => {
    expect(resolveRuntimeModeAgainstSticky('plan', undefined)).toBe('plan')
    expect(resolveRuntimeModeAgainstSticky('agent', undefined)).toBe('agent')
  })
})
