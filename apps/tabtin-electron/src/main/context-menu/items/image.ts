import { Menu, MenuItem, clipboard } from 'electron'
import type { ContextMenuContext } from '../types'
import { openUrlInNewTab } from '../helpers'
import { t } from '../i18n'

const GOOGLE_LENS_SCHEMES = /^https?:\/\//i

export function appendImageItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const { viewId, mainWindow, webContents } = ctx

  menu.append(new MenuItem({
    label: t('openImageInNewTab'),
    click: () => openUrlInNewTab(params.srcURL, viewId, mainWindow),
  }))
  menu.append(new MenuItem({
    label: t('saveImageAs'),
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.downloadURL(params.srcURL)
      }
    },
  }))
  menu.append(new MenuItem({
    label: t('copyImage'),
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.copyImageAt(params.x, params.y)
      }
    },
  }))
  menu.append(new MenuItem({
    label: t('copyImageAddress'),
    click: () => clipboard.writeText(params.srcURL),
  }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({
    label: t('searchImageOnGoogle'),
    enabled: GOOGLE_LENS_SCHEMES.test(params.srcURL),
    click: () => {
      const searchUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(params.srcURL)}`
      openUrlInNewTab(searchUrl, viewId, mainWindow)
    },
  }))
}
