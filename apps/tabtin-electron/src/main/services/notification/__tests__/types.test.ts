import { describe, it, expect } from 'vitest'
import { resolveCategoryKey, DEFAULT_PREFS } from '../types'

describe('resolveCategoryKey', () => {
  it('should resolve agent.task.completed → agent.task.result', () => {
    expect(resolveCategoryKey('agent.task.completed')).toBe('agent.task.result')
  })

  it('should resolve agent.task.error → agent.task.result', () => {
    expect(resolveCategoryKey('agent.task.error')).toBe('agent.task.result')
  })

  it('should resolve agent.hitl.waiting → agent.hitl', () => {
    expect(resolveCategoryKey('agent.hitl.waiting')).toBe('agent.hitl')
  })

  it('should resolve agent interruption events separately', () => {
    expect(resolveCategoryKey('agent.task.interrupted')).toBe('agent.task.interruption')
    expect(resolveCategoryKey('agent.task.session_interrupted')).toBe('agent.task.interruption')
  })

  it('should resolve tracker.run.completed → tracker.run', () => {
    expect(resolveCategoryKey('tracker.run.completed')).toBe('tracker.run')
  })

  it('should resolve resource collaboration events → collaboration', () => {
    expect(resolveCategoryKey('tabdoc.comment.mention')).toBe('collaboration')
    expect(resolveCategoryKey('tabdata.comment.mention')).toBe('collaboration')
    expect(resolveCategoryKey('resource_shared')).toBe('collaboration')
  })

  it('should resolve im.mention → im', () => {
    expect(resolveCategoryKey('im.mention')).toBe('im')
  })

  it('should resolve im.message → im', () => {
    expect(resolveCategoryKey('im.message')).toBe('im')
  })

  it('should resolve download.completed → download', () => {
    expect(resolveCategoryKey('download.completed')).toBe('download')
  })

  it('should resolve extension.event → extension', () => {
    expect(resolveCategoryKey('extension.event')).toBe('extension')
  })

  it('should resolve system.update → system.update', () => {
    expect(resolveCategoryKey('system.update')).toBe('system.update')
  })

  it('should return undefined for unknown types', () => {
    expect(resolveCategoryKey('unknown.type')).toBeUndefined()
  })
})

describe('DEFAULT_PREFS', () => {
  it('should have all notifications enabled by default', () => {
    expect(DEFAULT_PREFS.enabled).toBe(true)
    expect(DEFAULT_PREFS.desktopEnabled).toBe(true)
    expect(DEFAULT_PREFS.dockBadgeEnabled).toBe(true)
    expect(DEFAULT_PREFS.soundEnabled).toBe(true)
  })

  it('should have DND disabled by default', () => {
    expect(DEFAULT_PREFS.dndEnabled).toBe(false)
  })

  it('should have empty categoryOverrides', () => {
    expect(DEFAULT_PREFS.categoryOverrides).toEqual({})
  })
})
