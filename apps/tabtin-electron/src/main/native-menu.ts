/**
 * NativeMenu - 原生菜单处理器
 *
 * 参考 Min Browser 的 remoteMenu.js 设计：
 * - 渲染进程发送菜单模板到主进程
 * - 主进程使用 Electron Menu API 创建原生菜单
 * - 原生菜单不会被 WebContentsView 遮挡
 */

import { ipcMain, Menu, MenuItem, BrowserWindow } from 'electron'
import { guardedOn } from './utils/guarded-handle'
import { createLogger } from './logger'

const log = createLogger('NativeMenu')

const MAX_LABEL_LENGTH = 128
const MAX_SUBMENU_DEPTH = 5

function sanitizeLabel(label: unknown): string {
  if (typeof label !== 'string') return ''
  return label.slice(0, MAX_LABEL_LENGTH)
}

/** 菜单项模板 */
export interface NativeMenuItemTemplate {
  id: string
  label?: string
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  checked?: boolean
  enabled?: boolean
  visible?: boolean
  accelerator?: string
  icon?: string
  sublabel?: string
  role?: string
  submenu?: NativeMenuItemTemplate[]
}

/** 菜单请求数据 */
interface OpenMenuRequest {
  menuId: string
  template: NativeMenuItemTemplate[][]  // 二维数组，每个子数组是一个分组
  x?: number
  y?: number
}

/**
 * 注册原生菜单 IPC 处理器
 */
export function registerNativeMenuHandlers(): void {
  log.info('注册 IPC 处理器...')

  ipcMain.removeAllListeners('native-menu:open')

  guardedOn('native-menu:open', (event: Electron.IpcMainEvent, data: OpenMenuRequest) => {
   try {
    const menu = new Menu()
    const { menuId, template, x, y } = data
    log.debug(`native-menu:open menuId=${menuId} sections=${template?.length ?? 0}`)

    template.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) {
        menu.append(new MenuItem({ type: 'separator' }))
      }

      section.forEach((item) => {
        if (item.type === 'separator') {
          menu.append(new MenuItem({ type: 'separator' }))
          return
        }

        const menuItem = new MenuItem({
          label: sanitizeLabel(item.label),
          type: item.type || 'normal',
          checked: item.checked,
          enabled: item.enabled !== false,
          visible: item.visible !== false,
          accelerator: item.accelerator,
          sublabel: item.sublabel,
          click: () => {
            event.sender.send('native-menu:item-clicked', {
              menuId,
              itemId: item.id
            })
          },
          submenu: item.submenu ? buildSubmenu(item.submenu, event.sender, menuId, 1) : undefined
        })

        menu.append(menuItem)
      })
    })

    menu.on('menu-will-close', () => {
      // menu-will-close fires BEFORE the menu item click callback,
      // so delay the closed notification to let item-clicked arrive first.
      setTimeout(() => {
        event.sender.send('native-menu:closed', { menuId })
      }, 50)
    })

    const window = BrowserWindow.fromWebContents(event.sender)

    menu.popup({
      window: window || undefined,
      frame: (event.sender as any).focusedFrame ?? (event.sender as any).mainFrame,
      x,
      y
    } as any)
   } catch (error) {
     log.error(`native-menu:open 处理失败 menuId=${data?.menuId}:`, error)
   }
  })

  log.info('✅ IPC 处理器注册完成')
}

/**
 * 构建子菜单（含递归深度限制，防止渲染进程恶意输入导致主进程崩溃）
 */
function buildSubmenu(
  items: NativeMenuItemTemplate[],
  sender: Electron.WebContents,
  menuId: string,
  depth: number = 1
): Menu {
  const submenu = new Menu()

  if (depth > MAX_SUBMENU_DEPTH) {
    log.warn(`子菜单超过最大递归深度(${MAX_SUBMENU_DEPTH})，截断`)
    return submenu
  }

  items.forEach((item) => {
    if (item.type === 'separator') {
      submenu.append(new MenuItem({ type: 'separator' }))
      return
    }

    submenu.append(new MenuItem({
      label: sanitizeLabel(item.label),
      type: item.type || 'normal',
      checked: item.checked,
      enabled: item.enabled !== false,
      visible: item.visible !== false,
      accelerator: item.accelerator,
      sublabel: item.sublabel,
      click: () => {
        sender.send('native-menu:item-clicked', {
          menuId,
          itemId: item.id
        })
      },
      submenu: item.submenu ? buildSubmenu(item.submenu, sender, menuId, depth + 1) : undefined
    }))
  })

  return submenu
}

/**
 * 注销原生菜单 IPC 处理器
 */
export function unregisterNativeMenuHandlers(): void {
  ipcMain.removeAllListeners('native-menu:open')
  log.info('IPC 处理器已注销')
}
