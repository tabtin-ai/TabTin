import { Menu, MenuItem } from 'electron'
import type { ContextMenuContext } from '../types'
import { t } from '../i18n'

export function appendEditableItems(
  menu: Menu,
  params: Electron.ContextMenuParams,
  _ctx: ContextMenuContext
): void {
  const flags = params.editFlags

  menu.append(new MenuItem({ label: t('undo'), accelerator: 'CmdOrCtrl+Z', role: 'undo', enabled: flags.canUndo }))
  menu.append(new MenuItem({ label: t('redo'), accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo', enabled: flags.canRedo }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({ label: t('cut'), accelerator: 'CmdOrCtrl+X', role: 'cut', enabled: flags.canCut }))
  menu.append(new MenuItem({ label: t('copy'), accelerator: 'CmdOrCtrl+C', role: 'copy', enabled: flags.canCopy }))
  menu.append(new MenuItem({ label: t('paste'), accelerator: 'CmdOrCtrl+V', role: 'paste', enabled: flags.canPaste }))
  menu.append(new MenuItem({ label: t('selectAll'), accelerator: 'CmdOrCtrl+A', role: 'selectAll', enabled: flags.canSelectAll }))
}
