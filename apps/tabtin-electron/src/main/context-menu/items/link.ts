import { Menu, MenuItem, clipboard } from 'electron'
import type { ContextMenuContext } from '../types'
import { openOrFocusAuxWindow } from '../auxiliary-window-manager'
import { openUrlInNewTab } from '../helpers'
import { t } from '../i18n'

export function appendLinkItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const { viewId, mainWindow, webContents } = ctx

  menu.append(new MenuItem({
    label: t('openLinkInNewTab'),
    click: () => openUrlInNewTab(params.linkURL, viewId, mainWindow),
  }))
  menu.append(new MenuItem({
    label: t('openLinkInNewWindow'),
    click: () => {
      let title = params.linkURL
      try { title = new URL(params.linkURL).hostname } catch { /* ignore */ }
      openOrFocusAuxWindow(`link:${params.linkURL}`, params.linkURL, title)
    },
  }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({
    label: t('saveLinkAs'),
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.downloadURL(params.linkURL)
      }
    },
  }))
  menu.append(new MenuItem({
    label: t('copyLinkAddress'),
    click: () => clipboard.writeText(params.linkURL),
  }))
}
