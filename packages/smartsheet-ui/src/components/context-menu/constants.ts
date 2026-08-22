/**
 * Context Menu Constants
 * 菜单尺寸常量
 */

import { ZIndex } from '@tabtin/app-shell'

export const MENU_CONFIG = {
  // 菜单容器
  minWidth: 180,
  padding: 8,
  gap: 8,                 // between sections
  borderRadius: 4,
  borderWidth: 0.5,       // 极细
  zIndex: ZIndex.dropdown, // 使用语义化常量

  // 菜单项
  item: {
    padding: 4,
    gap: 8,               // icon to text
    minHeight: 30,        // 4*2 + 22
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 22,
    iconSize: 20,         // font-size
  },

  // 分隔线
  divider: {
    height: 0.5,          // 极细
    margin: 4,
  },

  // Section 间距
  section: {
    gap: 4,               // items gap
    dividerMargin: 4,     // between sections
  },

  // 子菜单
  subMenu: {
    offsetMainAxis: 16,   // horizontal
    offsetCrossAxis: -8.5, // vertical align
    expandDelay: 150,
    arrowSize: 16,
  },

  // 输入框
  input: {
    height: 28,
    padding: '4px 8px',
    fontSize: 14,
    borderRadius: 4,
  },

  // 标题栏
  header: {
    padding: '4px 4px 8px',
    marginBottom: 4,
    fontSize: 14,
    fontWeight: 500,
  },
} as const

// 动画时长
export const ANIMATION_DURATION = {
  enter: 150,
  exit: 100,
  hover: 80,
} as const

// 动画曲线
export const ANIMATION_EASING = {
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  hover: 'ease-out',
} as const

// Floating UI 偏移配置
export const FLOATING_OFFSET = 4
export const FLOATING_SHIFT_PADDING = 8  // 边界 padding

