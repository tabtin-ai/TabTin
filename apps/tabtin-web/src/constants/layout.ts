/**
 * 布局常量 — 从 Electron 端提取，保持一致
 * @see apps/tabtin-electron/src/renderer/src/constants/layout.ts
 */
export const LayoutConstraints = {
  sidebar: {
    navWidth: 64,
    minWidth: 64,
    maxWidth: 64,
    collapsedWidth: 48,
    defaultWidth: 64,
  },
} as const
