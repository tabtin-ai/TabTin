/**
 * ResizableSidebar（旧版可拖拽宽度的左侧栏）
 *
 * Shell 已迁移为：
 * - 全局侧栏：`SpaceSidebarGlobal`（左侧主 sidebar，含 Header/Tabs/Footer/portal slot）
 * - 主区域与右侧面板分栏：`AppLayout` 内 `resizable-v4`（`LayoutGroup` / `LayoutPanel`）
 *
 * 历史上部分分支/文档仍引用本路径；保留空实现可消除「文件不存在」类工具链报错。
 * **新代码禁止 import 本模块** — 请使用 `SpaceSidebarGlobal` 与 `resizable-v4`。
 */
import type { FC } from 'react'

export interface ResizableSidebarProps {
  width: number
  collapsed: boolean
  onResize: (width: number) => void
}

/** @deprecated 请使用 `SpaceSidebarGlobal` + `AppLayout`（`resizable-v4`） */
export const ResizableSidebar: FC<ResizableSidebarProps> = () => null
