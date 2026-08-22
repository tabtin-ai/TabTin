/**
 * Composer Preset 注入机制
 *
 * 与 useContextInjection 对称：
 * - emitComposerPreset：任何模块可调用，触发 Preset 激活
 * - useComposerPresetInjection：ChatPanel 挂载，监听全局事件
 */

import { useEffect } from 'react'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import type { PresetTriggerContext } from './registry/types'

const EVENT_NAME = 'tabtin:composer-preset'

export interface ComposerPresetEvent {
  presetId: string
  triggerContext?: PresetTriggerContext
  initialState?: Record<string, unknown>
}

/**
 * 发射方：任何模块都可以调用此函数激活一个 Preset
 */
export function emitComposerPreset(payload: ComposerPresetEvent): void {
  window.dispatchEvent(
    new CustomEvent<ComposerPresetEvent>(EVENT_NAME, { detail: payload }),
  )
}

/**
 * 消费方：在 ChatPanel 中调用，监听全局事件并激活 Preset。
 * scopeId 既可以是真实 sessionId，也可以是“未落库新会话”的草稿作用域。
 */
export function useComposerPresetInjection(scopeId: string | null, enabled = true): void {
  useEffect(() => {
    if (!enabled || !scopeId) return

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ComposerPresetEvent>).detail
      if (!detail?.presetId) return

      useComposerPresetStore
        .getState()
        .addPreset(scopeId, detail.presetId, detail.triggerContext, detail.initialState)
    }

    window.addEventListener(EVENT_NAME, handler)
    return () => window.removeEventListener(EVENT_NAME, handler)
  }, [enabled, scopeId])
}
