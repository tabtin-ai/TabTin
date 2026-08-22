import { Menu, MenuItem, type BrowserWindow } from 'electron'
import { openUrlInWorkspaceTab } from '../crawlspace/open-in-tab'
import type { ContextMenuContext } from './types'
import { t } from './i18n'
import { buildSearchUrl } from './browser-search-engine'

export function openUrlInNewTab(url: string, viewId: string, mainWindow: BrowserWindow): void {
  openUrlInWorkspaceTab({ url, viewId, mainWindow })
}

export function appendSearchForItem(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const text = params.selectionText?.trim()
  if (!text) return
  const displayText = text.length > 20 ? text.substring(0, 20) + '…' : text
  const searchUrl = buildSearchUrl(text)
  menu.append(new MenuItem({
    label: t('searchFor', { text: displayText }),
    click: () => openUrlInNewTab(searchUrl, ctx.viewId, ctx.mainWindow),
  }))
}

export function cleanupSeparators(menu: Menu): Menu {
  const items = menu.items
  if (items.length === 0) return menu

  // 先计算需要保留哪些条目（不直接 append 原 MenuItem 对象到多个 Menu，
  // Electron 中同一 MenuItem 实例绑定到 Menu 后再追加到另一个 Menu 行为未定义）
  type KeepEntry = { type: 'separator' } | { type: 'item'; original: Electron.MenuItem }
  const kept: KeepEntry[] = []
  let lastWasSeparator = true

  for (const item of items) {
    if (item.type === 'separator') {
      if (!lastWasSeparator) {
        kept.push({ type: 'separator' })
        lastWasSeparator = true
      }
    } else {
      kept.push({ type: 'item', original: item })
      lastWasSeparator = false
    }
  }

  // 去掉末尾分隔符
  while (kept.length > 0 && kept[kept.length - 1].type === 'separator') {
    kept.pop()
  }

  const result = new Menu()
  for (const entry of kept) {
    if (entry.type === 'separator') {
      result.append(new MenuItem({ type: 'separator' }))
    } else {
      // 通过 original 的属性重建 MenuItem，避免同一实例被追加到多个 Menu
      const orig = entry.original
      result.append(new MenuItem({
        label: orig.label,
        type: orig.type as any,
        checked: orig.checked,
        enabled: orig.enabled,
        visible: orig.visible,
        accelerator: orig.accelerator ?? undefined,
        sublabel: orig.sublabel,
        click: (orig as any).click,
        submenu: (orig as any).submenu,
      }))
    }
  }

  return result
}
