/**
 * ContextMenuBuilder - 根据 Electron ContextMenuParams 构建原生右键菜单
 *
 * 纯编排器：不包含具体菜单项逻辑，只负责根据上下文决定「显示哪些组」。
 * 各菜单组的实现见 items/*.ts。
 */

import { Menu, MenuItem } from 'electron'
import type { ContextMenuContext } from './types'
import { appendSearchForItem, cleanupSeparators } from './helpers'
import { appendLinkItems } from './items/link'
import { appendImageItems } from './items/image'
import { appendMediaItems } from './items/media'
import { appendSelectionItems } from './items/selection'
import { appendEditableItems } from './items/editable'
import { appendNavigationItems } from './items/navigation'
import { appendPageActionItems } from './items/page-actions'
import { appendDevItems } from './items/dev'
import { t } from './i18n'
import { shouldAllowBrowserDevTools } from '../package-protection'

export function buildContextMenu(
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): Menu {
  const menu = new Menu()

  const hasLink = Boolean(params.linkURL)
  const hasImage = params.mediaType === 'image'
  const hasMedia = params.mediaType === 'video' || params.mediaType === 'audio'
  const hasSelection = Boolean(params.selectionText?.trim())
  const isEditable = params.isEditable

  // ── 链接操作组 ──
  if (hasLink) {
    appendLinkItems(menu, params, ctx)
    menu.append(new MenuItem({ type: 'separator' }))
  }

  // ── 图片操作组 ──
  if (hasImage) {
    appendImageItems(menu, params, ctx)
    menu.append(new MenuItem({ type: 'separator' }))
  }

  // ── 媒体操作组（视频/音频） ──
  if (hasMedia) {
    appendMediaItems(menu, params, ctx)
    menu.append(new MenuItem({ type: 'separator' }))
  }

  // ── 可编辑区域 ──
  if (isEditable) {
    appendEditableItems(menu, params, ctx)
    if (hasSelection) {
      menu.append(new MenuItem({ type: 'separator' }))
      appendSearchForItem(menu, params, ctx)
    }
  } else {
    if (hasSelection) {
      appendSelectionItems(menu, params, ctx)
      menu.append(new MenuItem({ type: 'separator' }))
    }

    if (!hasLink && !hasImage && !hasMedia) {
      appendNavigationItems(menu, params, ctx)
      menu.append(new MenuItem({ type: 'separator' }))
    }

    if (!hasSelection) {
      menu.append(new MenuItem({ label: t('selectAll'), accelerator: 'CmdOrCtrl+A', role: 'selectAll' }))
    }
  }

  // ── 页面操作组（打印 / 另存为 / 截图） ──
  if (!isEditable) {
    menu.append(new MenuItem({ type: 'separator' }))
    appendPageActionItems(menu, params, ctx)
  }

  // ── 开发者工具 ──
  if (shouldAllowBrowserDevTools()) {
    menu.append(new MenuItem({ type: 'separator' }))
    appendDevItems(menu, params, ctx)
  }

  return cleanupSeparators(menu)
}
