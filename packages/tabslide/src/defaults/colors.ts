/**
 * TabSlide 默认数据颜色（唯一真源）
 *
 * 这些是 PPT 文档数据层的默认颜色，必须是 hex 格式（用于 PPTX 导入导出兼容）。
 * UI 皮肤层的颜色请使用 theme.ts 的语义 token。
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  修改规则：                                              │
 * │  1. 改这里 = 全局改默认色，影响新建文档的数据层。        │
 * │  2. 不影响已有文档（已持久化数据中的颜色不会被覆盖）。   │
 * │  3. UI 渲染 fallback 请用 theme.ts token，不要引此文件。 │
 * └──────────────────────────────────────────────────────────┘
 */

/** 幻灯片默认背景色（白色） */
export const SLIDE_BG = '#ffffff'

/** 默认文本颜色（中性深灰） */
export const TEXT_COLOR = '#1f2937'

/** 默认品牌色（蓝色，用于形状填充等） */
export const BRAND_COLOR = '#2563eb'

/** 默认强调色（红色，用于圆形等辅助形状） */
export const ACCENT_COLOR = '#dc2626'

/** 默认演示文稿主题色板 */
export const THEME_COLORS = [
  '#2563eb', // 蓝
  '#0f766e', // 青
  '#059669', // 绿
  '#f59e0b', // 橙
  '#dc2626', // 红
  '#7c3aed', // 紫
] as const

/** 默认字体名 */
export const FONT_NAME = 'Microsoft YaHei'
