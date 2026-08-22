import { Menu, MenuItem } from 'electron'
import type { ContextMenuContext } from '../types'
import { appendSearchForItem } from '../helpers'
import { t } from '../i18n'

export function appendSelectionItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  ctx: ContextMenuContext
): void {
  menu.append(new MenuItem({ label: t('copy'), accelerator: 'CmdOrCtrl+C', role: 'copy' }))
  appendSearchForItem(menu, params, ctx)
}
