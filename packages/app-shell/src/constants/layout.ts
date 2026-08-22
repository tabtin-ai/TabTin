export const ZIndex = {
  base: 0,
  sticky: 10,
  floating: 20,
  banner: 30,
  overlay: 40,
  modal: 50,
  dropdown: 55,
  toast: 60,
  global: 9999,
  aboveGlobal: 10000,
  /** MessageHost：须盖过 Lightbox / 全屏遮罩（aboveGlobal），否则下载提醒看不见 */
  toastHost: 10050,
} as const

export const LayoutConstraints = {
  sidebar: {
    navWidth: 64,
    minWidth: 64,
    maxWidth: 64,
    collapsedWidth: 48,
    defaultWidth: 64,
  },
  settingsSidebar: {
    minWidth: 240,
    maxWidth: 360,
    defaultWidth: 280,
  },
  pinned: {
    minWidth: 260,
    maxWidth: 420,
    defaultWidth: 320,
  },
  chat: {
    minWidth: 360,
    maxWidth: 940,
    defaultWidth: 520,
  },
  chatSidePanel: {
    /** 对话区最低可读宽度（对话模式主位 / 桌面模式辅位共用） */
    minWidth: 435,
    maxWidth: 800,
    collapsedWidth: 48,
    defaultWidth: 685,
  },
  /** 对话模式下右侧画布辅助位（与 chatSidePanel 独立持久化；无硬性 maxWidth） */
  canvasSidePanel: {
    minWidth: 360,
    defaultWidth: 560,
  },
  /** 聊天最大化模式下左侧会话列表宽度（拖拽调节范围） */
  chatSessionList: {
    minWidth: 180,
    maxWidth: 400,
    defaultWidth: 240,
  },
  contentPanel: {
    minWidth: 120,
  },
  context: {
    minWidth: 420,
  },
} as const
