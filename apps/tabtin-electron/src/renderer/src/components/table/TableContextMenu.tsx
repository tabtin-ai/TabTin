/**
 * 表格右键菜单组件
 * 使用新的 ContextMenu 系统
 */

import React, { useState, useEffect, useCallback } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuInput,
  ContextMenuTextarea,
  ContextMenuDivider,
  toast
} from '@tabtin/smartsheet-ui'
import { Pencil, Trash2 } from 'lucide-react'
import type { Table } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'

export interface TableContextMenuProps {
  table: Table | null
  position: { x: number; y: number } | null
  onEdit: (table: Table, updates: { name?: string; icon?: string; description?: string }) => Promise<void>
  onDelete: (table: Table) => Promise<void>
  onClose: () => void
}

type MenuMode = 'main' | 'edit'

export const TableContextMenu: React.FC<TableContextMenuProps> = ({
  table,
  position,
  onEdit,
  onDelete,
  onClose,
}) => {
  const { t } = useTranslation(['table', 'common'])
  const [menuMode, setMenuMode] = useState<MenuMode>('main')
  const [editingName, setEditingName] = useState('')
  const [editingIcon, setEditingIcon] = useState('')
  const [editingDescription, setEditingDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // 初始化编辑态
  useEffect(() => {
    if (table) {
      setEditingName(table.name)
      setEditingIcon(table.icon || '📄')
      setEditingDescription(table.description || '')
    }
  }, [table])

  // 重置状态
  useEffect(() => {
    if (!position) {
      setMenuMode('main')
    }
  }, [position])

  const handleCloseMenu = useCallback(() => {
    setMenuMode('main')
    onClose()
  }, [onClose])

  const handleSave = useCallback(async () => {
    if (!table || !editingName.trim() || isSubmitting) return

    setIsSubmitting(true)
    try {
      await onEdit(table, {
        name: editingName.trim(),
        icon: editingIcon,
        description: editingDescription.trim() || undefined,
      })
      toast({
        variant: 'success',
        title: t('table:contextMenu.updateSuccessTitle'),
        description: t('table:contextMenu.updateSuccessDesc', { name: editingName.trim() }),
      })
      handleCloseMenu()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('table:contextMenu.updateFailedTitle'),
        description: error instanceof Error ? error.message : t('table:contextMenu.updateFailedDesc'),
      })
    } finally {
      setIsSubmitting(false)
    }
  }, [table, editingName, editingIcon, editingDescription, isSubmitting, onEdit, handleCloseMenu, t])

  const handleDelete = useCallback(async () => {
    if (!table) return

    try {
      await onDelete(table)
      toast({
        variant: 'success',
        title: t('table:contextMenu.deleteSuccessTitle'),
        description: t('table:contextMenu.deleteSuccessDesc', { name: table.name }),
      })
      handleCloseMenu()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('table:contextMenu.deleteFailedTitle'),
        description: error instanceof Error ? error.message : t('table:contextMenu.deleteFailedDesc'),
      })
    }
  }, [table, onDelete, handleCloseMenu, t])

  const getHeader = useCallback(() => {
    if (!table) return undefined

    if (menuMode === 'main') {
      return {
        title: table.name,
        icon: <span className="text-subtitle">{table.icon || '📄'}</span>,
      }
    } else if (menuMode === 'edit') {
      return {
        title: t('table:contextMenu.edit'),
        icon: <Pencil className="h-5 w-5" />,
        onBack: () => setMenuMode('main'),
      }
    }
    return undefined
  }, [table, menuMode, t])

  const renderMainMenu = () => (
    <>
      <ContextMenuItem
        icon={<Pencil className="h-4 w-4"  />}
        label={t('table:contextMenu.edit')}
        closeOnClick={false}
        onClick={() => setMenuMode('edit')}
      />
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<Trash2 className="h-4 w-4"  />}
        label={t('table:contextMenu.delete')}
        danger
        onClick={handleDelete}
      />
    </>
  )

  const renderEditMenu = () => (
    <>
      <div className="px-3 pb-1 text-body text-muted-foreground">{t('table:contextMenu.iconLabel')}</div>
      <ContextMenuInput
        defaultValue={editingIcon}
        onChange={setEditingIcon}
        placeholder="📄"
        maxLength={2}
      />
      <div className="px-3 pb-1 text-body text-muted-foreground">{t('table:contextMenu.nameLabel')}</div>
      <ContextMenuInput
        defaultValue={editingName}
        onChange={setEditingName}
        placeholder={t('table:contextMenu.namePlaceholder')}
      />
      <div className="px-3 pb-1 text-body text-muted-foreground">{t('table:contextMenu.descriptionLabel')}</div>
      <ContextMenuTextarea
        defaultValue={editingDescription}
        onChange={setEditingDescription}
        placeholder={t('table:contextMenu.descriptionPlaceholder')}
      />
      <ContextMenuDivider />
      <ContextMenuItem
        label={isSubmitting ? t('table:contextMenu.saving') : t('table:contextMenu.save')}
        disabled={isSubmitting || !editingName.trim()}
        closeOnClick={false}
        onClick={handleSave}
      />
      <ContextMenuItem
        label={t('table:contextMenu.cancel')}
        onClick={handleCloseMenu}
      />
    </>
  )

  const isOpen = Boolean(table && position)

  return (
    <ContextMenu
      open={isOpen}
      onClose={handleCloseMenu}
      anchorPosition={position || undefined}
      header={getHeader()}
    >
      {menuMode === 'main' && renderMainMenu()}
      {menuMode === 'edit' && renderEditMenu()}
    </ContextMenu>
  )
}
