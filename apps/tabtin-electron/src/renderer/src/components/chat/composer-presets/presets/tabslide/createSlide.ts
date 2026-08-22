/**
 * TabSlide 创建演示文稿 Preset（M1 人机交互闭环）
 *
 * 触发场景：
 * - 用户在 Space Home 的 TabSlide section 点击"+ 新建"
 * - useCreateHandlers.handleCreateSlide 通过 enterChatSession({ composerPreset: ... })
 *   将本 preset 注入新会话的输入框上方
 * - 用户填好表单点发送，contextBlocks 携带 composer_preset block，
 *   后端 ContextResolver._resolve_composer_preset_ref 将其拍平为自然语言注入 Agent
 */

import { registerComposerPreset } from '../../registry/composerPresetRegistry'
import type { ComposerPresetDescriptor } from '../../registry/types'
import { TABSLIDE_UI_ENABLED } from '@/utils/featureFlags'

const createSlidePreset: ComposerPresetDescriptor = {
  id: 'tabslide.createSlide',
  labelKey: 'tabslide:preset.createSlide.label',
  descriptionKey: 'tabslide:preset.createSlide.description',
  icon: '📊',
  category: 'tabslide',
  sessionStrategy: 'new',

  fields: [
    {
      key: 'topic',
      type: 'textarea',
      label: '演讲主题',
      placeholder: '描述这个 Slide 要讲什么。例：「Q3 业务复盘 + Q4 重点策略」',
      required: true,
      errorMessage: '请填写主题',
      config: { rows: 3 },
    },
    {
      key: 'audience',
      type: 'input',
      col: 6,
      label: '目标听众',
      placeholder: '例：管理团队 / 投资人 / 内部周会',
    },
    {
      key: 'page_count',
      type: 'number',
      col: 6,
      label: '页数预估',
      defaultValue: 10,
      validate: { min: 3, max: 50 },
      errorMessage: '页数 3-50 之间',
      config: { suffix: '页' },
    },
    {
      key: 'template',
      type: 'select',
      col: 6,
      label: '版式',
      defaultValue: 'business',
      config: {
        variant: 'button-group',
        options: [
          { value: 'business', label: '商业' },
          { value: 'academic', label: '学术' },
          { value: 'minimal', label: '极简' },
          { value: 'creative', label: '创意' },
        ],
      },
    },
    {
      key: 'tone',
      type: 'select',
      col: 6,
      label: '风格',
      defaultValue: 'rigorous',
      config: {
        options: [
          { value: 'rigorous', label: '严谨' },
          { value: 'lively', label: '活泼' },
          { value: 'storytelling', label: '叙事' },
          { value: 'data_driven', label: '数据驱动' },
        ],
      },
    },
    {
      key: 'reference_image',
      type: 'upload',
      label: '参考图（可选）',
      placeholder: '点击上传你想参考的封面或风格图',
      config: { accept: 'image/*' },
    },
  ],

  addons: [
    {
      key: 'styling',
      label: '配色与字体',
      icon: '🎨',
      fields: [
        {
          key: 'color_scheme',
          type: 'select',
          col: 6,
          label: '主色系',
          defaultValue: 'auto',
          config: {
            options: [
              { value: 'auto', label: '自动' },
              { value: 'blue', label: '蓝调' },
              { value: 'warm', label: '暖色' },
              { value: 'mono', label: '黑白' },
              { value: 'green', label: '绿色' },
            ],
          },
        },
        {
          key: 'language',
          type: 'select',
          col: 6,
          label: '语言',
          defaultValue: 'zh',
          config: {
            options: [
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
              { value: 'bilingual', label: '中英双语' },
            ],
          },
        },
      ],
    },
    {
      key: 'extras',
      label: '额外要求',
      icon: '✨',
      fields: [
        {
          key: 'must_include',
          type: 'textarea',
          label: '必须包含的要点',
          placeholder: '一行一个，例：\n收入同比 +28%\n华东市场拓展进度',
          config: { rows: 3 },
        },
        {
          key: 'avoid',
          type: 'input',
          label: '避免提到',
          placeholder: '例：未公开的财务细节',
        },
      ],
    },
  ],
}

// ：TabSlide App UI 隐藏期间不注册「新建演示文稿」preset——
// 用户「做 PPT」走 Agent 生成本地 .pptx 的路径，不引导进入云端编辑器。
if (TABSLIDE_UI_ENABLED) {
  registerComposerPreset(createSlidePreset)
}
