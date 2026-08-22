import React from 'react'

export type ToolbarOverflowRunOptions = {
  /** true：先卸菜单，双 rAF 后再跑（截图/注释，避免把浮层拍进去） */
  defer?: boolean
}

export type ToolbarOverflowRun = (
  action?: () => void,
  options?: ToolbarOverflowRunOptions,
) => void

const noopRun: ToolbarOverflowRun = (action) => {
  action?.()
}

/**
 * 窄态 `...` 菜单内：子项通过此 context 关闭菜单并（可选）推迟执行业务动作。
 * 不要用 capture 阶段 setOpen(false) 卸 Content——会吞掉子按钮 onClick。
 */
export const ToolbarOverflowCloseContext = React.createContext<ToolbarOverflowRun>(noopRun)

export function useToolbarOverflowRun(): ToolbarOverflowRun {
  return React.useContext(ToolbarOverflowCloseContext)
}
