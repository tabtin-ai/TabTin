import { describe, expect, it } from 'vitest'
import {
  SESSION_SHARE_CAN_CHAT_ENABLED,
  buildSessionShareModeOptions,
  buildShareTierOptions,
  clampToSelectableShareTier,
  getShareTierPresentation,
  resolveShareTierLevel,
  shareTierToFlags,
} from './sessionSharePresentation'

const t = (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key

describe('sessionSharePresentation', () => {
  it('resolveShareTierLevel 递进语义', () => {
    expect(resolveShareTierLevel(false, false)).toBe('view')
    expect(resolveShareTierLevel(true, false)).toBe('fork')
    expect(resolveShareTierLevel(true, true)).toBe('control')
    expect(resolveShareTierLevel(false, true)).toBe('control')
  })

  it('getShareTierPresentation 返回场景化标题', () => {
    expect(getShareTierPresentation(false, false, t).title).toBe('实时查看')
    expect(getShareTierPresentation(true, false, t).title).toBe('查看并抄走')
    expect(getShareTierPresentation(true, true, t).title).toBe('实时协作')
  })

  it('shareTierToFlags 映射 v2 查看 / Fork / 协作权限', () => {
    expect(shareTierToFlags('view')).toEqual({ canFork: false, canChat: false })
    expect(shareTierToFlags('fork')).toEqual({ canFork: true, canChat: false })
    expect(shareTierToFlags('control')).toEqual({ canFork: false, canChat: true })
  })

  it('新入口开放查看、Fork 和协作三档', () => {
    expect(SESSION_SHARE_CAN_CHAT_ENABLED).toBe(true)
    expect(buildShareTierOptions(t).map((option) => option.value)).toEqual(['view', 'fork', 'control'])
    expect(clampToSelectableShareTier('control')).toBe('control')
    expect(clampToSelectableShareTier('fork')).toBe('fork')
    expect(clampToSelectableShareTier('view')).toBe('view')
  })

  it('两个共享入口只展示查看、协作与任务交接', () => {
    expect(buildSessionShareModeOptions(t).map((option) => option.value)).toEqual([
      'view',
      'control',
      'continue',
    ])
  })
})
