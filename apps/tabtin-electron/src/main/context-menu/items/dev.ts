import { Menu, MenuItem } from 'electron'
import type { ContextMenuContext } from '../types'
import { openOrFocusAuxWindow } from '../auxiliary-window-manager'
import { t } from '../i18n'

export function appendDevItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const { webContents } = ctx
  const pageUrl = params.pageURL || webContents.getURL()
  const isHttpUrl = pageUrl && /^https?:\/\//i.test(pageUrl)

  menu.append(new MenuItem({
    label: t('viewPageSource'),
    enabled: Boolean(isHttpUrl),
    click: () => {
      if (!webContents.isDestroyed() && isHttpUrl) {
        openOrFocusAuxWindow(
          `view-source:${pageUrl}`,
          `view-source:${pageUrl}`,
          `${t('viewPageSource')} - ${pageUrl}`
        )
      }
    },
  }))
  menu.append(new MenuItem({
    label: t('inspect'),
    accelerator: 'CmdOrCtrl+Alt+I',
    click: () => {
      if (!webContents.isDestroyed()) {
        webContents.inspectElement(params.x, params.y)
        if (!webContents.isDevToolsOpened()) {
          webContents.openDevTools({ mode: 'detach' })
        }
      }
    },
  }))
}
