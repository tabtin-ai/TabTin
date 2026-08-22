/**
 * Composer Presets 核心类型定义
 *
 * 设计原则：
 * - Block 极简：不携带 Agent 已有的上下文（syncContext 管理），不携带指令（后端 PRESET_PROMPTS 管理）
 * - 附件统一：upload 类型字段走 ChatAttachment + uploadAllAttachments 管线
 * - 声明优先：大多数 Preset 通过 fields + addons 声明式定义，零 React 代码
 * - 扩展开放：字段类型可注册，渲染器可注册，描述符可运行时注入
 */

import type React from 'react'
import type { ChatAttachment } from '../../types'

// ============================================================
// 字段系统
// ============================================================

export type PresetFieldType =
  | 'input'
  | 'number'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'toggle'
  | 'upload'
  | 'slider'
  | 'color'
  | 'tags'
  | 'group'

export interface FieldValidation {
  pattern?: 'url' | 'email' | RegExp
  type?: 'number' | 'integer'
  min?: number
  max?: number
  maxLength?: number
  custom?: (value: unknown) => string | null
}

export interface PresetField {
  key: string
  type: PresetFieldType

  label?: string
  labelKey?: string
  placeholder?: string
  placeholderKey?: string
  description?: string

  defaultValue?: unknown
  required?: boolean

  validate?: FieldValidation
  errorMessage?: string
  errorMessageKey?: string

  /** 列宽（12 列栅格，默认 12 = 满宽）。col: 6 = 半宽，col: 4 = 三分之一 */
  col?: number

  /** 条件显示：根据其他字段值决定是否渲染 */
  visibleWhen?: { field: string; equals: unknown }

  /** 类型专属配置（select 的 options、upload 的 accept 等） */
  config?: Record<string, unknown>
}

// ============================================================
// Addon（可开关的附加参数组）
// ============================================================

export interface PresetAddon {
  key: string
  label?: string
  labelKey?: string
  icon?: string
  fields: PresetField[]
  defaultActive?: boolean
}

// ============================================================
// 文本模板变量
// ============================================================

export interface PromptVariable {
  key: string
  label?: string
  labelKey?: string
  /** 支持全部字段类型，在文本中以内联形态渲染；'text' 为 'input' 的别名 */
  type: PresetFieldType | 'url' | 'text'
  defaultValue?: unknown
  placeholder?: string
  options?: Array<{ value: string; label: string }>
  /** 类型专属配置（与 PresetField.config 一致） */
  config?: Record<string, unknown>
}

// ============================================================
// 触发上下文
// ============================================================

/**
 * 触发动作特有的瞬时数据（如"在时间线 12.5s 处右键→生成片段"）。
 * 不含 app_id / resource_id 等 Agent 已通过 syncContext 知道的信息。
 */
export interface PresetTriggerContext {
  [key: string]: unknown
}

// ============================================================
// Preset 描述符
// ============================================================

export interface ComposerPresetDescriptor {
  id: string
  labelKey: string
  descriptionKey?: string
  icon?: string
  /** 模块分类，用于过滤（'tabvideo' | 'tabslide' | 'generation' | ...） */
  category: string

  /**
   * 触发时的会话策略建议：
   * - 'current'：在当前会话中插入（默认，适合上下文相关的小任务）
   * - 'new'：创建新会话（适合独立的大任务）
   * - 'ask'：让用户选择
   */
  sessionStrategy?: 'current' | 'new' | 'ask'

  // ---- 文本模板模式：一段 prompt 里嵌入可编辑变量槽 ----
  /** 模板文案，用 {{key}} 标记变量位置 */
  promptTemplate?: string
  /** 模板中的变量定义 */
  variables?: PromptVariable[]

  // ---- 表单字段模式：结构化字段堆叠 ----
  fields?: PresetField[]
  addons?: PresetAddon[]

  // ---- 自定义渲染器 ----
  /** 指向 COMPOSER_RENDERERS 注册表的 key；提供时优先于 fields/promptTemplate */
  renderer?: string

  /** 系统生成的 preset 可用自定义 renderer 控制卡片编辑体验。 */
  readOnly?: boolean

  /**
   * 序列化：组件 state + 上传后的附件 → 进入 stream blocks 的结构。
   * 声明式模式有默认实现（params = state 中有值的字段）。
   */
  serializeForSend?: (
    state: Record<string, unknown>,
    uploadedSlots: Record<string, Array<{ url: string; fileId: string }>>,
    triggerContext?: PresetTriggerContext,
  ) => ComposerPresetBlock

  /** 表单级验证（字段级验证在 field.validate） */
  canSubmit?: (state: Record<string, unknown>) => boolean
}

// ============================================================
// Block（发送到后端的结构）
// ============================================================

export interface ComposerPresetBlock {
  type: 'composer_preset'
  preset_id: string
  params: Record<string, unknown>
  trigger_context?: Record<string, unknown>
}

// ============================================================
// 渲染器 Props
// ============================================================

/** Level 2 自定义渲染器的统一 Props */
export interface ComposerPresetProps {
  preset: ComposerPresetDescriptor
  state: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  disabled?: boolean
  triggerContext?: PresetTriggerContext

  addSlotAttachment: (slotKey: string, file: File) => void
  removeSlotAttachment: (slotKey: string, attachmentId: string) => void
  slotAttachments: Record<string, ChatAttachment[]>
}

export type ComposerPresetComponent = React.FC<ComposerPresetProps>

/** Level 1 字段类型原子渲染器的 Props */
export interface FieldRendererProps {
  field: PresetField
  value: unknown
  onChange: (value: unknown) => void
  error?: string | null
  disabled?: boolean

  /** upload 类型专用 */
  slotAttachments?: ChatAttachment[]
  onAddSlotAttachment?: (file: File) => void
  onRemoveSlotAttachment?: (attachmentId: string) => void
}

export type FieldRendererComponent = React.FC<FieldRendererProps>

// ============================================================
// Store 相关
// ============================================================

export interface PresetInstance {
  instanceId: string
  presetId: string
  state: Record<string, unknown>
  triggerContext?: PresetTriggerContext
  collapsed: boolean
  activeAddonKeys: string[]
  errors: Record<string, string | null>
  /** 各 upload 字段槽位的附件（key = field.key） */
  slotAttachments: Record<string, ChatAttachment[]>
}

export interface ActivatePresetPayload {
  presetId: string
  triggerContext?: PresetTriggerContext
  initialState?: Record<string, unknown>
}

export {
  COMPOSER_PRESET_BLOCK_TYPE,
  COMPOSER_PRESET_PENDING_TYPE,
} from '@utils/chat/composerPresetBlocks'
