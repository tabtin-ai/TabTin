import { describe, expect, it } from 'vitest'
import {
  deriveBlockSettingsEdit,
  effectiveCanEditAgentSettings,
  effectiveCanManageSpaceSettings,
} from '../useSpaceSettingsEditGuard'

describe('deriveBlockSettingsEdit', () => {
  it('does not treat isResolving as permanently read-only (no silent disable)', () => {
    // useIsRemoteViewer 三态：resolving 应短暂骨架，不是遥控器拦截。
    // 历史上 blockSettingsEdit = isRemoteViewer || isResolving 会静默灰死 YOLO 开关。
    // 调用方传完整 remote 对象时，只要不是真·遥控器就不应锁编辑。
    expect(
      deriveBlockSettingsEdit({
        isRemoteViewer: false,
      }),
    ).toBe(false)
  })

  it('blocks only true remote viewers', () => {
    expect(
      deriveBlockSettingsEdit({ isRemoteViewer: true }),
    ).toBe(true)
  })

  it('allows local control / unsettled control_device window', () => {
    expect(
      deriveBlockSettingsEdit({ isRemoteViewer: false }),
    ).toBe(false)
  })
})

describe('effectiveCanEditAgentSettings', () => {
  it('allows edit on execution device when role permits', () => {
    expect(
      effectiveCanEditAgentSettings(true, { blockSettingsEdit: false }),
    ).toBe(true)
  })

  it('blocks edit for remote viewer even when role permits', () => {
    expect(
      effectiveCanEditAgentSettings(true, { blockSettingsEdit: true }),
    ).toBe(false)
  })

  it('blocks edit when role is insufficient', () => {
    expect(
      effectiveCanEditAgentSettings(false, { blockSettingsEdit: false }),
    ).toBe(false)
  })
})

describe('effectiveCanManageSpaceSettings', () => {
  it('blocks admin manage actions for remote viewer', () => {
    expect(
      effectiveCanManageSpaceSettings(true, { blockSettingsEdit: true }),
    ).toBe(false)
  })
})
