/**
 * window.tabtinComposerPresets — 开放注册 API
 *
 * 允许外部开发者 / 插件 / MCP 工具在运行时注册自定义 Preset。
 * 底层走标准的 registerComposerPreset + registerComposerRenderer + emitComposerPreset。
 *
 * 注意：window.tabtin 由 contextBridge.exposeInMainWorld 创建，是不可扩展的代理对象，
 * 因此 API 安装在独立的顶级 key window.tabtinComposerPresets。
 */

import type {
  ComposerPresetDescriptor,
  ComposerPresetComponent,
  FieldRendererComponent,
  PresetTriggerContext,
} from './registry/types'
import { registerComposerPreset, getComposerPreset, getAllPresets, getPresetsByCategory } from './registry/composerPresetRegistry'
import { registerComposerRenderer } from './registry/composerRenderers'
import { registerFieldRenderer } from './registry/fieldRenderers'
import { emitComposerPreset } from './useComposerPresetInjection'

export interface ComposerPresetsPublicAPI {
  register: (options: {
    descriptor: ComposerPresetDescriptor
    renderer?: ComposerPresetComponent
  }) => void

  registerFieldType: (type: string, component: FieldRendererComponent) => void

  activate: (options: {
    presetId: string
    triggerContext?: PresetTriggerContext
    initialState?: Record<string, unknown>
  }) => void

  get: (presetId: string) => ComposerPresetDescriptor | null
  list: (category?: string) => ComposerPresetDescriptor[]
}

export function createComposerPresetsAPI(): ComposerPresetsPublicAPI {
  return {
    register({ descriptor, renderer }) {
      registerComposerPreset(descriptor)
      if (renderer && descriptor.renderer) {
        registerComposerRenderer(descriptor.renderer, renderer)
      }
    },

    registerFieldType(type, component) {
      registerFieldRenderer(type, component)
    },

    activate({ presetId, triggerContext, initialState }) {
      emitComposerPreset({ presetId, triggerContext, initialState })
    },

    get(presetId) {
      return getComposerPreset(presetId)
    },

    list(category) {
      return category ? getPresetsByCategory(category) : getAllPresets()
    },
  }
}

/**
 * 安装到 window.tabtinComposerPresets
 *
 * 注意：window.tabtin 由 contextBridge.exposeInMainWorld 创建，
 * 是不可扩展的代理对象，不能直接挂载新属性，因此使用独立的顶级 key。
 *
 * 在 Electron renderer 入口处调用一次
 */
export function installComposerPresetsWindowAPI(): void {
  if (typeof window === 'undefined') return

  const w = window as unknown as Record<string, unknown>
  w.tabtinComposerPresets = createComposerPresetsAPI()
}
