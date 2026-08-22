import { describe, expect, it } from 'vitest'
import {
  isTemporarilyHiddenSkill,
  EMPTY_HIDDEN_SKILL_SETS,
  type HiddenSkillSets,
} from '../temporarily-hidden-skills.js'

// 具体名单是宿主运营决策；测试里模拟宿主注入的 tabvideo 集合。
const tabvideoHidden: HiddenSkillSets = {
  appIds: new Set(['tabvideo']),
  keys: new Set(['app:tabvideo/tabvideo-operator']),
}

describe('isTemporarilyHiddenSkill', () => {
  it('按注入的 key 隐藏 tabvideo operator', () => {
    expect(isTemporarilyHiddenSkill({
      canonicalKey: 'app:tabvideo/tabvideo-operator',
      appId: 'tabvideo',
    }, tabvideoHidden)).toBe(true)
  })

  it('按注入的 appId 隐藏整个 tabvideo 命名空间', () => {
    expect(isTemporarilyHiddenSkill({
      canonicalKey: 'app:tabvideo/other',
      appId: 'tabvideo',
    }, tabvideoHidden)).toBe(true)
  })

  it('仅凭 canonicalKey 命名空间前缀即可隐藏（appId 缺失也生效）', () => {
    expect(isTemporarilyHiddenSkill({
      canonicalKey: 'app:tabvideo/other',
    }, tabvideoHidden)).toBe(true)
  })

  it('不误伤其他 app skill', () => {
    expect(isTemporarilyHiddenSkill({
      canonicalKey: 'app:tabdoc/tabdoc-operator',
      appId: 'tabdoc',
    }, tabvideoHidden)).toBe(false)
  })

  it('默认空集不隐藏任何 skill', () => {
    expect(isTemporarilyHiddenSkill({
      canonicalKey: 'app:tabvideo/tabvideo-operator',
      appId: 'tabvideo',
    }, EMPTY_HIDDEN_SKILL_SETS)).toBe(false)
  })
})
