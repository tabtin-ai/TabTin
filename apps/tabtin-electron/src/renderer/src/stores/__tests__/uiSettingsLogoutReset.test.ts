import { describe, expect, it } from 'vitest'
import { useUIStore } from '../useUIStore'
import { useVoiceSettingsStore, DEFAULT_VOICE_SHORTCUT } from '../useVoiceSettingsStore'
import { useResourceOpenPreferences } from '../useResourceOpenPreferences'
import { DEFAULT_COLOR_SCHEME } from '@/constants/color-schemes'
import { resetSessionState } from '../sessionReset'

/**
 * 重要-1 回归：换账号登出时，已接后端同步的三个 store 必须把**内存态**重置为默认，
 * 否则同进程换人登录后 reconcile 的"远端缺失→推本地"会把上个人的内存值写进新账号云端。
 */
describe('IA Phase 2 · 换账号登出 → 同步偏好内存重置', () => {
  it('logout 后 useUIStore / useVoiceSettingsStore / useResourceOpenPreferences 内存回默认', async () => {
    // 模拟"上一个账号"在内存里改过的同步偏好
    useUIStore.setState({ theme: 'dark', uiFontSize: 'large', colorScheme: 'blue' })
    useVoiceSettingsStore.setState({
      customHotwords: ['张三', '李四'],
      replacementRules: [{ id: 'r1', from: '嗯', to: '', isEnabled: true }],
      voiceShortcut: 'mod+shift+z',
      enableAppContext: false,
      enableDialogContext: false,
      enabled: false,
    })
    useResourceOpenPreferences.setState({
      preferences: { 'type:document': 'tabdoc', 'scheme:https:': 'tabweb' },
      sessionOverrides: { 'type:document': 'tabcode' },
    })

    await resetSessionState('logout')

    // useUIStore：三个同步 namespace 回默认
    expect(useUIStore.getState().theme).toBe('system')
    expect(useUIStore.getState().uiFontSize).toBe('default')
    expect(useUIStore.getState().colorScheme).toBe(DEFAULT_COLOR_SCHEME)

    // useVoiceSettingsStore：长期资产 + 标量全部回默认
    expect(useVoiceSettingsStore.getState().customHotwords).toEqual([])
    expect(useVoiceSettingsStore.getState().replacementRules).toEqual([])
    expect(useVoiceSettingsStore.getState().voiceShortcut).toBe(DEFAULT_VOICE_SHORTCUT)
    expect(useVoiceSettingsStore.getState().enableAppContext).toBe(true)
    expect(useVoiceSettingsStore.getState().enableDialogContext).toBe(true)
    expect(useVoiceSettingsStore.getState().enabled).toBe(true)

    // useResourceOpenPreferences：持久偏好 + 会话覆盖都清空
    expect(useResourceOpenPreferences.getState().preferences).toEqual({})
    expect(useResourceOpenPreferences.getState().sessionOverrides).toEqual({})
  })
})
