/**
 * UI slice — Chat 面板开关与宽度。
 *
 * 从 useChatStore 抽离最独立的一块 UI 状态：面板是否打开、面板宽度，以及
 * togglePanel / setPanelWidth 两个动作。初始值 + 逻辑内聚在本 slice，
 * useChatStore 只做 spread 装配（ 分层重构）。
 *
 * 与 modePreferenceSlice 同款：类型仍在 ChatState 契约里声明，本工厂提供
 * 初始值与实现；用泛型 RootState 约束让 zustand 的 set 直接可传。
 */

import { LayoutConstraints } from '@/constants/layout'

export interface UiStore {
  /** Chat 面板是否打开 */
  isPanelOpen: boolean
  /** Chat 面板宽度 */
  panelWidth: number
  /** 切换面板开关 */
  togglePanel: () => void
  /** 设置面板宽度（clamp 到 [minWidth, maxWidth]） */
  setPanelWidth: (width: number) => void
}

export function createUiActions<RootState extends UiStore>(
  set: (partial: Partial<RootState> | ((state: RootState) => Partial<RootState>)) => void,
): UiStore {
  return {
    isPanelOpen: true,
    panelWidth: LayoutConstraints.chat.defaultWidth,
    togglePanel: () => {
      set((state) => ({ isPanelOpen: !state.isPanelOpen }) as Partial<RootState>)
    },
    setPanelWidth: (width: number) => {
      set(() => ({
        panelWidth: Math.max(
          LayoutConstraints.chat.minWidth,
          Math.min(LayoutConstraints.chat.maxWidth, width),
        ),
      }) as Partial<RootState>)
    },
  }
}
