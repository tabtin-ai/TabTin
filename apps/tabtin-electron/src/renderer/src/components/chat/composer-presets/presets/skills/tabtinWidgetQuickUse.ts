import { registerComposerPreset } from '../../registry/composerPresetRegistry'
import type { ComposerPresetBlock, ComposerPresetDescriptor, PromptVariable } from '../../registry/types'
import { SKILL_QUICK_USE_PREVIEW_RENDERER } from './SkillQuickUsePreviewRenderer'

export const TABTIN_WIDGET_QUICK_USE_PRESET_ID = 'skill.tabtinWidget.quickUse'
export const TABTIN_WIDGET_SKILL_KEY = 'platform:visualization/tabtin-widget'

export const TABTIN_WIDGET_QUICK_USE_TEMPLATE =
  '请使用 tabtin-widget，帮我生成一个 {{subject}}。\n' +
  '视觉风格：{{style}}\n' +
  '重点展示：{{focus}}\n' +
  '输出要求：优先用 Mermaid 或 SVG，适合在 chat 中直接查看。'

export const TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE: Record<string, unknown> = {
  subject: '上海未来一周天气趋势图',
  style: '清晰简洁',
  focus: '展示每天的天气、最高/最低温、降雨概率和出行提醒',
}

export const TABTIN_WIDGET_QUICK_USE_VARIABLES: PromptVariable[] = [
  {
    key: 'subject',
    type: 'textarea',
    label: '要画什么',
    placeholder: '例：一个产品增长飞轮 / 新用户 onboarding 流程 / 数据看板结构',
    defaultValue: TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE.subject,
    config: { rows: 2 },
  },
  {
    key: 'style',
    type: 'select',
    label: '视觉风格',
    defaultValue: '清晰简洁',
    options: [
      { value: '清晰简洁', label: '清晰简洁' },
      { value: '商务汇报', label: '商务汇报' },
      { value: '科技感', label: '科技感' },
      { value: '手绘白板', label: '手绘白板' },
    ],
  },
  {
    key: 'focus',
    type: 'textarea',
    label: '重点信息',
    placeholder: '例：突出输入、处理、输出三段关系；展示关键指标变化',
    defaultValue: TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE.focus,
    config: { rows: 2 },
  },
]

function valueAsString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function buildTabtinWidgetQuickUsePrompt(state: Record<string, unknown>): string {
  const subject = valueAsString(state.subject)
  const style = valueAsString(state.style) || valueAsString(TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE.style)
  const focus = valueAsString(state.focus)

  return [
    `请使用 tabtin-widget，帮我生成一个 ${subject}。`,
    `视觉风格：${style}`,
    `重点展示：${focus || valueAsString(TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE.focus)}`,
    '输出要求：优先用 Mermaid 或 SVG，适合在 chat 中直接查看。',
  ].join('\n')
}

export const TABTIN_WIDGET_QUICK_USE_PRESET: ComposerPresetDescriptor = {
  id: TABTIN_WIDGET_QUICK_USE_PRESET_ID,
  labelKey: '快速使用 tabtin-widget',
  descriptionKey: '从 Skill 详情页自动生成可发送的可视化提示词',
  icon: '✨',
  category: 'skill',
  sessionStrategy: 'current',
  renderer: SKILL_QUICK_USE_PREVIEW_RENDERER,
  promptTemplate: TABTIN_WIDGET_QUICK_USE_TEMPLATE,
  variables: TABTIN_WIDGET_QUICK_USE_VARIABLES,
  canSubmit(state) {
    return valueAsString(state.subject).length > 0
  },
  serializeForSend(state, _uploadedSlots, triggerContext): ComposerPresetBlock {
    return {
      type: 'composer_preset',
      preset_id: TABTIN_WIDGET_QUICK_USE_PRESET_ID,
      params: {
        skill_key: TABTIN_WIDGET_SKILL_KEY,
        subject: valueAsString(state.subject),
        style: valueAsString(state.style) || valueAsString(TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE.style),
        focus: valueAsString(state.focus),
        rendered_prompt: buildTabtinWidgetQuickUsePrompt(state),
      },
      ...(triggerContext && Object.keys(triggerContext).length > 0
        ? { trigger_context: triggerContext }
        : {}),
    }
  },
}

registerComposerPreset(TABTIN_WIDGET_QUICK_USE_PRESET)
