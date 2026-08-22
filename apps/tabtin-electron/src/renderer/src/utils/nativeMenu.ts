/**
 * 原生菜单工具函数
 *
 * 使用 Electron 原生 Menu API 替代 DOM 菜单，
 * 解决右键菜单被 WebContentsView 遮挡的问题。
 *
 * @example
 * ```tsx
 * import { openNativeContextMenu, type NativeMenuItem } from '@/utils/nativeMenu'
 *
 * const handleContextMenu = (e: React.MouseEvent) => {
 *   e.preventDefault()
 *
 *   const items: NativeMenuItem[] = [
 *     { id: 'rename', label: '重命名', onClick: () => handleRename() },
 *     { id: 'sep1', type: 'separator' },
 *     { id: 'delete', label: '删除', onClick: () => handleDelete() },
 *   ]
 *
 *   openNativeContextMenu(items, e.clientX, e.clientY)
 * }
 * ```
 */

import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('NativeMenu')

/** 菜单项类型 */
export interface NativeMenuItem {
  /** 唯一标识 */
  id: string
  /** 显示标签 */
  label?: string
  /** 菜单项类型 */
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  /** 是否选中（checkbox/radio） */
  checked?: boolean
  /** 是否启用 */
  enabled?: boolean
  /** 快捷键 */
  accelerator?: string
  /** 点击回调 */
  onClick?: () => void
  /** 子菜单 */
  submenu?: NativeMenuItem[]
}

/** 菜单选项 */
export interface NativeMenuOptions {
  /** 菜单关闭时的回调 */
  onClose?: () => void
}

/**
 * 打开原生右键菜单
 *
 * @param items 菜单项列表（支持分组：连续的非 separator 项会被自动分组）
 * @param x 菜单 X 坐标
 * @param y 菜单 Y 坐标
 * @param options 菜单选项
 * @returns 清理函数
 */
export function openNativeContextMenu(
  items: NativeMenuItem[],
  x?: number,
  y?: number,
  options?: NativeMenuOptions
): () => void {
  // contract W2-β: utils 层不再直接 import ipcRenderer——委托到 preload `nativeMenu.open`
  // 抽象，preload 内部用 sendIpc + ipcRenderer.on/removeListener 完整管理生命周期，
  // utils 只把 NativeMenuItem 转成 preload 期望的 template + callbacks 形态。
  const nativeMenu = window.tabtin?.nativeMenu
  if (!nativeMenu?.open) {
    log.warn(i18n.t('common:logs.nativeMenuUnavailable'))
    return () => {}
  }

  const groups = groupMenuItems(items)

  const callbacks: Record<string, () => void> = {}
  const collectCallbacks = (menuItems: NativeMenuItem[]) => {
    menuItems.forEach(item => {
      if (item.onClick) {
        callbacks[item.id] = item.onClick
      }
      if (item.submenu) {
        collectCallbacks(item.submenu)
      }
    })
  }
  collectCallbacks(items)

  const template = groups.map(group =>
    group.map(item => ({
      id: item.id,
      label: item.label,
      type: item.type,
      checked: item.checked,
      enabled: item.enabled,
      accelerator: item.accelerator,
      submenu: item.submenu?.map(sub => ({
        id: sub.id,
        label: sub.label,
        type: sub.type as 'normal' | 'separator' | undefined,
        enabled: sub.enabled,
      })),
    })),
  )

  return nativeMenu.open(template, callbacks, x, y, options?.onClose)
}

/**
 * 将菜单项列表按 separator 分组
 */
function groupMenuItems(items: NativeMenuItem[]): NativeMenuItem[][] {
  const groups: NativeMenuItem[][] = []
  let currentGroup: NativeMenuItem[] = []

  items.forEach(item => {
    if (item.type === 'separator') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
      }
    } else {
      currentGroup.push(item)
    }
  })

  // 添加最后一组
  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  return groups
}

/**
 * 创建分隔符菜单项
 */
export function menuSeparator(): NativeMenuItem {
  return { id: `sep-${Date.now()}`, type: 'separator' }
}
