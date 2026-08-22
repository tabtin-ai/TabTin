/**
 * W3.3 D-5 §1 · renderer 守护测试：useVoiceSettingsStore 注册 system:voice-settings bucket。
 *
 * 守住：
 *   1. import store 后 system:voice-settings 已注册（hideFromList=true，data 类）
 *   2. exportFn 产出 schemaVersion=1 + ISO exportedAt + 完整 6 字段配置
 *   3. exportFn JSON 可解析 + 字段类型正确
 *   4. clearFn 把 6 个字段全部还原默认值
 *   5. filename 含 ISO timestamp（精确到毫秒）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

describe('useVoiceSettingsStore · storage-manager 接入', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('store 模块加载后 system:voice-settings 已注册，字段符合 D-5 §1', async () => {
    await import('../useVoiceSettingsStore')
    const sm = await import('@tabtin/storage-manager')

    const bucket = sm.getBucket('system:voice-settings')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('system')
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(bucket?.hideFromList).toBe(true)
    expect(bucket?.warnings?.length ?? 0).toBeGreaterThan(0)
    // D-5 核心资产必须有 exportFn
    expect(typeof bucket?.exportFn).toBe('function')
    expect(typeof bucket?.clearFn).toBe('function')
  })

  it('exportFn 产出含 schemaVersion + ISO exportedAt + 6 字段配置的 JSON', async () => {
    const { useVoiceSettingsStore } = await import('../useVoiceSettingsStore')
    const sm = await import('@tabtin/storage-manager')

    useVoiceSettingsStore.getState().addHotword('TabTin')
    useVoiceSettingsStore.getState().addHotword('Codex')
    useVoiceSettingsStore.getState().addReplacementRule('orig', 'replaced')
    useVoiceSettingsStore.getState().setVoiceShortcut('mod+shift+v')
    useVoiceSettingsStore.getState().setEnableAppContext(false)
    useVoiceSettingsStore.getState().setEnabled(false)

    const bucket = sm.getBucket('system:voice-settings')!
    const exp = await bucket.exportFn!()

    expect(exp.mimeType).toBe('application/json')
    expect(exp.filename).toMatch(
      /^tabtin-voice-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z\.json$/,
    )

    const parsed = JSON.parse(exp.data as string)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      source: 'tabtin-electron',
      enabled: false,
      voiceShortcut: 'mod+shift+v',
      enableAppContext: false,
      enableDialogContext: true,
    })
    expect(parsed.customHotwords).toEqual(['TabTin', 'Codex'])
    expect(parsed.replacementRules).toHaveLength(1)
    expect(parsed.replacementRules[0]).toMatchObject({ from: 'orig', to: 'replaced', isEnabled: true })

    // exportedAt 必须是合法 ISO 时间字符串
    expect(typeof parsed.exportedAt).toBe('string')
    expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt)
  })

  it('clearFn 把 6 个字段全部还原默认值（dryRun 不改状态）', async () => {
    const { useVoiceSettingsStore, DEFAULT_VOICE_SHORTCUT } = await import('../useVoiceSettingsStore')
    const sm = await import('@tabtin/storage-manager')

    useVoiceSettingsStore.getState().addHotword('keep-me')
    useVoiceSettingsStore.getState().addReplacementRule('a', 'b')
    useVoiceSettingsStore.getState().setEnableAppContext(false)
    useVoiceSettingsStore.getState().setEnabled(false)

    const bucket = sm.getBucket('system:voice-settings')!

    // dryRun 不改状态
    const dry = await bucket.clearFn!({ dryRun: true })
    expect(dry.clearedItemCount).toBe(2)
    expect(useVoiceSettingsStore.getState().customHotwords).toContain('keep-me')

    // 真清后 6 字段都恢复默认
    await bucket.clearFn!()
    const state = useVoiceSettingsStore.getState()
    expect(state.customHotwords).toEqual([])
    expect(state.replacementRules).toEqual([])
    expect(state.voiceShortcut).toBe(DEFAULT_VOICE_SHORTCUT)
    expect(state.enabled).toBe(true)
    expect(state.enableAppContext).toBe(true)
    expect(state.enableDialogContext).toBe(true)
  })
})
