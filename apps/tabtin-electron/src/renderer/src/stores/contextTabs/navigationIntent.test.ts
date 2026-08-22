import { describe, expect, it } from 'vitest'
import {
  decideActiveKeyCommit,
  nextNavigationIntent,
  type NavigationIntent,
} from './navigationIntent'

const userIntent = (targetKey: string, revision = 3): NavigationIntent => ({
  revision,
  targetKey,
  writer: 'user',
  reason: 'click',
  at: 1,
})

describe('decideActiveKeyCommit', () => {
  it('user 始终可创建新意图', () => {
    const d = decideActiveKeyCommit({
      writer: 'user',
      currentActive: 'tabdata:a',
      nextActive: 'tabdoc:b',
      intent: userIntent('tabdata:a'),
      currentActiveStructurallyValid: true,
    })
    expect(d).toEqual({ allow: true, reason: 'user-intent', bumpRevision: true })
  })

  it('async_completion 在 revision 过期时拒绝', () => {
    const d = decideActiveKeyCommit({
      writer: 'async_completion',
      currentActive: 'tabdata:a',
      nextActive: 'tabweb:v1',
      intent: userIntent('tabdata:a', 5),
      expectedRevision: 4,
      currentActiveStructurallyValid: true,
    })
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('async-stale-revision')
  })

  it('restore 不得覆盖仍有效的用户目标', () => {
    const d = decideActiveKeyCommit({
      writer: 'restore',
      currentActive: 'tabdoc:d1',
      nextActive: 'tabweb:old',
      intent: userIntent('tabdoc:d1'),
      currentActiveStructurallyValid: true,
    })
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('restore-blocked-by-user-intent')
  })

  it('restore 不得覆盖用户回工作台首页（targetKey=null）', () => {
    const homeIntent: NavigationIntent = {
      revision: 4,
      targetKey: null,
      writer: 'user',
      reason: 'openHome',
      at: 1,
    }
    const d = decideActiveKeyCommit({
      writer: 'restore',
      currentActive: null,
      nextActive: 'tabdata:first',
      intent: homeIntent,
      currentActiveStructurallyValid: true,
    })
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('restore-blocked-by-user-intent')
  })

  it('fallback 仅在 active 结构失效时允许', () => {
    expect(decideActiveKeyCommit({
      writer: 'fallback',
      currentActive: 'tabdata:a',
      nextActive: 'tabdata:b',
      intent: userIntent('tabdata:a'),
      currentActiveStructurallyValid: true,
    }).allow).toBe(false)

    expect(decideActiveKeyCommit({
      writer: 'fallback',
      currentActive: 'tabdata:gone',
      nextActive: 'tabdata:b',
      intent: userIntent('tabdata:gone'),
      currentActiveStructurallyValid: false,
    }).allow).toBe(true)
  })

  it('self_heal 保留结构仍有效的用户目标', () => {
    const d = decideActiveKeyCommit({
      writer: 'self_heal',
      currentActive: 'tabdoc:d1',
      nextActive: 'tabdata:first',
      intent: userIntent('tabdoc:d1'),
      currentActiveStructurallyValid: true,
    })
    expect(d.allow).toBe(false)
  })
})

describe('nextNavigationIntent', () => {
  it('bumpRevision 时单调递增', () => {
    const prev = userIntent('tabdata:a', 2)
    const next = nextNavigationIntent(prev, {
      writer: 'user',
      targetKey: 'tabdoc:b',
      reason: 'open',
      bumpRevision: true,
      nowMs: 99,
    })
    expect(next.revision).toBe(3)
    expect(next.targetKey).toBe('tabdoc:b')
    expect(next.at).toBe(99)
  })
})
