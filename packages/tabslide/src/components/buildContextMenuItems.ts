import type { ContextMenuActions } from '../hooks/useContextMenuActions'

export type MenuItem = {
  label: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}
export type Divider = 'divider'
export type SubMenu = { label: string; items: MenuItem[] }
export type ContextMenuEntry = MenuItem | Divider | SubMenu

interface BuildContextMenuParams {
  translate: (key: string) => string
  /** 修饰键前缀（⌘ 或 Ctrl+） */
  mod: string
  /** 执行非变更动作后关闭菜单 */
  exec: (fn: () => void) => void
  /** 推快照后执行变更动作再关闭菜单 */
  execMutating: (fn: () => void) => void
  actions: ContextMenuActions
}

/**
 * 纯函数：根据选区状态生成右键菜单模型（label / disabled / 子菜单结构）。
 * 不含任何 DOM 或副作用，便于直接单测 disabled 与条目可见性。
 */
export function buildContextMenuItems({
  translate,
  mod,
  exec,
  execMutating,
  actions,
}: BuildContextMenuParams): ContextMenuEntry[] {
  const {
    selectedIds,
    singleId,
    hasSelection,
    hasDeletableSelection,
    hasClipboard,
    hasMovableLayerSelection,
    allLocked,
    allHidden,
    canAlign,
    canDistribute,
    canGroup,
    canUngroup,
    copy,
    cut,
    paste,
    selectAll,
    duplicateElements,
    bringSelectionToFront,
    bringForwardSelection,
    sendBackwardSelection,
    sendSelectionToBack,
    setLocked,
    setVisibility,
    deleteElements,
    handleAlign,
    groupSelected,
    ungroupSelected,
  } = actions

  const lockLabel = singleId
    ? (allLocked ? translate('contextMenu.unlock') : translate('contextMenu.lock'))
    : (allLocked ? translate('contextMenu.unlockSelected') : translate('contextMenu.lockSelected'))
  const visibilityLabel = singleId
    ? (allHidden ? translate('contextMenu.show') : translate('contextMenu.hide'))
    : (allHidden ? translate('contextMenu.showSelected') : translate('contextMenu.hideSelected'))

  return [
    { label: translate('contextMenu.copy'), shortcut: `${mod}C`, onClick: () => exec(copy), disabled: !hasSelection },
    { label: translate('contextMenu.cut'), shortcut: `${mod}X`, onClick: () => exec(cut), disabled: !hasDeletableSelection },
    { label: translate('contextMenu.paste'), shortcut: `${mod}V`, onClick: () => exec(paste), disabled: !hasClipboard },
    { label: translate('contextMenu.duplicate'), shortcut: `${mod}D`, onClick: () => execMutating(() => duplicateElements(selectedIds)), disabled: !hasDeletableSelection },
    'divider',
    { label: translate('contextMenu.selectAll'), shortcut: `${mod}A`, onClick: () => exec(selectAll) },
    'divider',
    {
      label: translate('contextMenu.layer'),
      items: [
        { label: translate('contextMenu.bringToFront'), shortcut: `${mod}⇧]`, onClick: () => execMutating(() => bringSelectionToFront(selectedIds)), disabled: !hasMovableLayerSelection },
        { label: translate('contextMenu.bringForward'), shortcut: `${mod}]`, onClick: () => execMutating(() => bringForwardSelection(selectedIds)), disabled: !hasMovableLayerSelection },
        { label: translate('contextMenu.sendBackward'), shortcut: `${mod}[`, onClick: () => execMutating(() => sendBackwardSelection(selectedIds)), disabled: !hasMovableLayerSelection },
        { label: translate('contextMenu.sendToBack'), shortcut: `${mod}⇧[`, onClick: () => execMutating(() => sendSelectionToBack(selectedIds)), disabled: !hasMovableLayerSelection },
      ],
    },
    ...(canAlign ? [{
      label: translate('contextMenu.align'),
      items: [
        { label: translate('align.left'), onClick: () => execMutating(() => handleAlign('left')) },
        { label: translate('align.horizontalCenter'), onClick: () => execMutating(() => handleAlign('horizontalCenter')) },
        { label: translate('align.right'), onClick: () => execMutating(() => handleAlign('right')) },
        { label: translate('align.top'), onClick: () => execMutating(() => handleAlign('top')) },
        { label: translate('align.verticalCenter'), onClick: () => execMutating(() => handleAlign('verticalCenter')) },
        { label: translate('align.bottom'), onClick: () => execMutating(() => handleAlign('bottom')) },
        ...(canDistribute ? [
          { label: translate('align.distributeH'), onClick: () => execMutating(() => handleAlign('distributeH')) } as MenuItem,
          { label: translate('align.distributeV'), onClick: () => execMutating(() => handleAlign('distributeV')) } as MenuItem,
        ] : []),
      ],
    } as SubMenu] : []),
    'divider',
    ...(canGroup ? [{ label: translate('contextMenu.group'), shortcut: `${mod}G`, onClick: () => execMutating(() => groupSelected()) } as MenuItem] : []),
    ...(canUngroup ? [{ label: translate('contextMenu.ungroup'), shortcut: `${mod}⇧G`, onClick: () => execMutating(() => ungroupSelected()) } as MenuItem] : []),
    ...(canGroup || canUngroup ? ['divider' as Divider] : []),
    ...(hasSelection ? [
      { label: lockLabel, onClick: () => execMutating(() => setLocked(selectedIds, !allLocked)) } as MenuItem,
      { label: visibilityLabel, onClick: () => execMutating(() => setVisibility(selectedIds, allHidden)) } as MenuItem,
      'divider' as Divider,
    ] : []),
    { label: translate('contextMenu.delete'), shortcut: '⌫', onClick: () => execMutating(() => deleteElements(selectedIds)), disabled: !hasDeletableSelection, danger: true },
  ]
}
