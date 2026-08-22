/** @store-category session */

/**
 * Composer Preset 状态管理
 *
 * 独立于 useChatStore，管理各会话的活跃 Preset 实例。
 * 数组结构：首期限制 1 张卡片，数据结构已支持多张。
 */

import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  PresetInstance,
  PresetTriggerContext,
  ComposerPresetDescriptor,
} from '@/components/chat/composer-presets/registry/types'
import { getComposerPreset } from '@/components/chat/composer-presets/registry/composerPresetRegistry'

interface ComposerPresetStoreState {
  /** 按 sessionId 存储活跃的 Preset 实例列表 */
  presetsBySessionId: Record<string, PresetInstance[]>

  /** 添加 Preset（首期：清除已有的，只允许一张） */
  addPreset: (
    sessionId: string,
    presetId: string,
    triggerContext?: PresetTriggerContext,
    initialState?: Record<string, unknown>,
  ) => void

  /** 更新 Preset 的 state（合并式） */
  updatePresetState: (
    sessionId: string,
    instanceId: string,
    patch: Record<string, unknown>,
  ) => void

  /** 设置字段错误 */
  setFieldError: (
    sessionId: string,
    instanceId: string,
    fieldKey: string,
    error: string | null,
  ) => void

  /** 追加 upload 槽位的附件 */
  addSlotAttachment: (
    sessionId: string,
    instanceId: string,
    slotKey: string,
    attachment: import('@/components/chat/types').ChatAttachment,
  ) => void

  /** 移除 upload 槽位的指定附件 */
  removeSlotAttachment: (
    sessionId: string,
    instanceId: string,
    slotKey: string,
    attachmentId: string,
  ) => void

  /** 获取所有 Preset 的 slot attachments（用于 ChatInput 合并到 attachments 数组） */
  collectSlotAttachments: (sessionId: string) => import('@/components/chat/types').ChatAttachment[]

  /** 切换 addon 激活状态 */
  toggleAddon: (sessionId: string, instanceId: string, addonKey: string) => void

  /** 切换折叠 */
  toggleCollapsed: (sessionId: string, instanceId: string) => void

  /** 移除单个 Preset */
  removePreset: (sessionId: string, instanceId: string) => void

  /** 清除某会话所有 Preset */
  clearAllPresets: (sessionId: string) => void

  /** 获取某会话的 Preset 列表 */
  getPresets: (sessionId: string) => PresetInstance[]
}

function buildInitialState(descriptor: ComposerPresetDescriptor): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const variable of descriptor.variables ?? []) {
    if (variable.defaultValue !== undefined) {
      state[variable.key] = variable.defaultValue
    }
  }
  for (const field of descriptor.fields ?? []) {
    if (field.defaultValue !== undefined) {
      state[field.key] = field.defaultValue
    }
  }
  for (const addon of descriptor.addons ?? []) {
    if (addon.defaultActive) {
      for (const field of addon.fields) {
        if (field.defaultValue !== undefined) {
          state[field.key] = field.defaultValue
        }
      }
    }
  }
  return state
}

function getDefaultActiveAddons(descriptor: ComposerPresetDescriptor): string[] {
  return (descriptor.addons ?? [])
    .filter(a => a.defaultActive)
    .map(a => a.key)
}

export const useComposerPresetStore = create<ComposerPresetStoreState>((set, get) => ({
  presetsBySessionId: {},

  addPreset: (sessionId, presetId, triggerContext, initialState) => {
    const descriptor = getComposerPreset(presetId)
    if (!descriptor) {
      console.warn(`[ComposerPreset] Unknown preset: ${presetId}`)
      return
    }

    const instance: PresetInstance = {
      instanceId: nanoid(8),
      presetId,
      state: { ...buildInitialState(descriptor), ...initialState },
      triggerContext,
      collapsed: false,
      activeAddonKeys: getDefaultActiveAddons(descriptor),
      errors: {},
      slotAttachments: {},
    }

    set(prev => ({
      presetsBySessionId: {
        ...prev.presetsBySessionId,
        [sessionId]: [instance],
      },
    }))
  },

  updatePresetState: (sessionId, instanceId, patch) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.map(inst =>
            inst.instanceId === instanceId
              ? { ...inst, state: { ...inst.state, ...patch } }
              : inst,
          ),
        },
      }
    })
  },

  setFieldError: (sessionId, instanceId, fieldKey, error) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.map(inst =>
            inst.instanceId === instanceId
              ? { ...inst, errors: { ...inst.errors, [fieldKey]: error } }
              : inst,
          ),
        },
      }
    })
  },

  addSlotAttachment: (sessionId, instanceId, slotKey, attachment) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.map(inst => {
            if (inst.instanceId !== instanceId) return inst
            const existing = inst.slotAttachments[slotKey] ?? []
            return {
              ...inst,
              slotAttachments: { ...inst.slotAttachments, [slotKey]: [...existing, attachment] },
            }
          }),
        },
      }
    })
  },

  removeSlotAttachment: (sessionId, instanceId, slotKey, attachmentId) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.map(inst => {
            if (inst.instanceId !== instanceId) return inst
            const existing = inst.slotAttachments[slotKey] ?? []
            return {
              ...inst,
              slotAttachments: {
                ...inst.slotAttachments,
                [slotKey]: existing.filter(a => a.id !== attachmentId),
              },
            }
          }),
        },
      }
    })
  },

  collectSlotAttachments: (sessionId) => {
    const list = get().presetsBySessionId[sessionId] ?? []
    const result: import('@/components/chat/types').ChatAttachment[] = []
    for (const inst of list) {
      for (const [slotKey, atts] of Object.entries(inst.slotAttachments)) {
        for (const att of atts) {
          result.push({
            ...att,
            presetSlotKey: slotKey,
            presetInstanceId: inst.instanceId,
          })
        }
      }
    }
    return result
  },

  toggleAddon: (sessionId, instanceId, addonKey) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.map(inst => {
            if (inst.instanceId !== instanceId) return inst
            const active = inst.activeAddonKeys.includes(addonKey)
            const newKeys = active
              ? inst.activeAddonKeys.filter(k => k !== addonKey)
              : [...inst.activeAddonKeys, addonKey]

            const newState = { ...inst.state }
            const newSlotAttachments = { ...inst.slotAttachments }
            const newErrors = { ...inst.errors }
            if (active) {
              const descriptor = getComposerPreset(inst.presetId)
              const addon = descriptor?.addons?.find(a => a.key === addonKey)
              if (addon) {
                for (const field of addon.fields) {
                  delete newState[field.key]
                  delete newSlotAttachments[field.key]
                  delete newErrors[field.key]
                }
              }
            }

            return {
              ...inst,
              activeAddonKeys: newKeys,
              state: newState,
              slotAttachments: newSlotAttachments,
              errors: newErrors,
            }
          }),
        },
      }
    })
  },

  toggleCollapsed: (sessionId, instanceId) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.map(inst =>
            inst.instanceId === instanceId
              ? { ...inst, collapsed: !inst.collapsed }
              : inst,
          ),
        },
      }
    })
  },

  removePreset: (sessionId, instanceId) => {
    set(prev => {
      const list = prev.presetsBySessionId[sessionId]
      if (!list) return prev
      return {
        presetsBySessionId: {
          ...prev.presetsBySessionId,
          [sessionId]: list.filter(inst => inst.instanceId !== instanceId),
        },
      }
    })
  },

  clearAllPresets: (sessionId) => {
    set(prev => ({
      presetsBySessionId: {
        ...prev.presetsBySessionId,
        [sessionId]: [],
      },
    }))
  },

  getPresets: (sessionId) => {
    return get().presetsBySessionId[sessionId] ?? []
  },
}))
