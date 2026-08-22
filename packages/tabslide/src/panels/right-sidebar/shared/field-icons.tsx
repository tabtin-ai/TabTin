/**
 * 属性面板字段图标集
 *
 * 对齐 Keynote / Sketch 的取向：数值簇与选择项用「图标」传达语义，不再堆文本标签。
 * 全部为自包含内联 SVG / 文本字形（无第三方图标依赖，杜绝导入名风险），
 * 统一 13px、strokeWidth 1.6、currentColor，随外层文字色走。
 */

import React from 'react'

const svg = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** 旋转 */
export const RotateIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
    <path d="M20.5 3.5v5h-5" />
  </svg>
)

/** 水平翻转 */
export const FlipHIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M12 3v18" strokeDasharray="2 2.5" />
    <path d="M9.5 8 5 12l4.5 4z" fill="currentColor" stroke="none" />
    <path d="M14.5 8 19 12l-4.5 4z" fill="currentColor" stroke="none" />
  </svg>
)

/** 垂直翻转 */
export const FlipVIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M3 12h18" strokeDasharray="2 2.5" />
    <path d="M8 9.5 12 5l4 4.5z" fill="currentColor" stroke="none" />
    <path d="M8 14.5 12 19l4-4.5z" fill="currentColor" stroke="none" />
  </svg>
)

/** 不透明度 */
export const OpacityIcon: React.FC = () => (
  <svg {...svg}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
  </svg>
)

/** 字号 */
export const FontSizeIcon: React.FC = () => (
  <span className="text-[11px] font-semibold leading-none tracking-tight">Aa</span>
)

/** 行高 */
export const LineHeightIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M4 6.5v11" />
    <path d="M2.5 8 4 6.5 5.5 8" />
    <path d="M2.5 16 4 17.5 5.5 16" />
    <line x1="9" y1="7" x2="20" y2="7" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="17" x2="20" y2="17" />
  </svg>
)

/** 字间距 */
export const LetterSpacingIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M4.5 5v14" />
    <path d="M19.5 5v14" />
    <line x1="8.5" y1="12" x2="15.5" y2="12" />
    <path d="M8.5 12 10.5 10M8.5 12 10.5 14" />
    <path d="M15.5 12 13.5 10M15.5 12 13.5 14" />
  </svg>
)

/** 段间距 */
export const ParagraphSpacingIcon: React.FC = () => (
  <span className="text-[13px] leading-none">¶</span>
)

/** 垂直对齐：顶 */
export const VAlignTopIcon: React.FC = () => (
  <svg {...svg}>
    <line x1="3.5" y1="5" x2="20.5" y2="5" />
    <line x1="7.5" y1="10" x2="16.5" y2="10" />
    <line x1="7.5" y1="14" x2="16.5" y2="14" />
  </svg>
)

/** 垂直对齐：中 */
export const VAlignMiddleIcon: React.FC = () => (
  <svg {...svg}>
    <line x1="7.5" y1="8" x2="16.5" y2="8" />
    <line x1="3.5" y1="12" x2="20.5" y2="12" />
    <line x1="7.5" y1="16" x2="16.5" y2="16" />
  </svg>
)

/** 垂直对齐：底 */
export const VAlignBottomIcon: React.FC = () => (
  <svg {...svg}>
    <line x1="7.5" y1="10" x2="16.5" y2="10" />
    <line x1="7.5" y1="14" x2="16.5" y2="14" />
    <line x1="3.5" y1="19" x2="20.5" y2="19" />
  </svg>
)

/** 竖排文本 */
export const VerticalTextIcon: React.FC = () => (
  <svg {...svg}>
    <line x1="7.5" y1="5" x2="7.5" y2="19" />
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="16.5" y1="5" x2="16.5" y2="19" />
  </svg>
)

/** 文本颜色（字母 A + 下方色条由外层色带体现，这里用描边 A 表意） */
export const TextColorIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M6 17 10.8 6h1.4L17 17" />
    <path d="M8 13h8" />
  </svg>
)

/** 文本背景 / 高亮 */
export const HighlightIcon: React.FC = () => (
  <svg {...svg}>
    <path d="M4 20h16" />
    <path d="M13.5 6.5 17.5 10.5" />
    <path d="M8 16l-1 3 3-1 8.5-8.5-2-2z" />
  </svg>
)
