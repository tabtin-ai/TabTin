import { Menu, MenuItem } from 'electron'
import { getEffectiveNavigationState } from '../../crawl-view/navigation-state'
import type { ContextMenuContext } from '../types'
import { t } from '../i18n'

export function appendNavigationItems(
  menu: Menu,
  _params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  const { webContents } = ctx
  const nav = webContents.navigationHistory
  const navigation = getEffectiveNavigationState(webContents)

  menu.append(new MenuItem({
    label: t('back'),
    enabled: navigation.canGoBack,
    click: () => {
      if (!webContents.isDestroyed() && getEffectiveNavigationState(webContents).canGoBack) {
        nav.goBack()
      }
    },
  }))
  menu.append(new MenuItem({
    label: t('forward'),
    enabled: navigation.canGoForward,
    click: () => { if (!webContents.isDestroyed()) nav.goForward() },
  }))
  menu.append(new MenuItem({
    label: t('reload'),
    accelerator: 'CmdOrCtrl+R',
    click: () => { if (!webContents.isDestroyed()) webContents.reload() },
  }))
}
