/**
 * 表格设置对话框
 */

import { joinApiPath } from '@tabtin/config'
import React, { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  Button,
  ScrollArea,
  toast,
} from '@tabtin/smartsheet-ui'
import { Settings, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTableStore } from '@/stores/useTableStore'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { API_CONFIG } from '@/config/api'
import { useTranslation } from 'react-i18next'
import { TableSettingsBasicForm } from './settings/TableSettingsBasicForm'
import { TableSettingsDangerZone } from './settings/TableSettingsDangerZone'
import { TableSettingsDeleteConfirmPanel } from './settings/TableSettingsDeleteConfirmPanel'
import { FieldRecycleBin } from './FieldRecycleBin'

interface TableSettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  tableId: string
}

const ICON_OPTIONS = ['📊', '📋', '📈', '📉', '📃', '📄', '📑', '🗂️']

export const TableSettingsDialog: React.FC<TableSettingsDialogProps> = ({
  isOpen,
  onClose,
  tableId,
}) => {
  const { t } = useTranslation(['table', 'common', 'tabdata'])
  const { tables, updateTable, deleteTable, archiveTable, restoreTable, isLoading } = useTableStore(
    useShallow((s) => ({
      tables: s.tables,
      updateTable: s.updateTable,
      deleteTable: s.deleteTable,
      archiveTable: s.archiveTable,
      restoreTable: s.restoreTable,
      isLoading: s.isLoading,
    }))
  )

  const table = tables.find(item => item.id === tableId)

  const [name, setName] = useState(table?.name || '')
  const [description, setDescription] = useState(table?.description || '')
  const [icon, setIcon] = useState(table?.icon || '📊')
  const [error, setError] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteInputValue, setDeleteInputValue] = useState('')
  const [showFieldRecycleBin, setShowFieldRecycleBin] = useState(false)

  useEffect(() => {
    if (!table) {
      return
    }

    setName(table.name)
    setDescription(table.description || '')
    setIcon(table.icon || '📊')
    setError('')
    setShowDeleteConfirm(false)
    setDeleteInputValue('')
    setShowFieldRecycleBin(false)
  }, [table])

  const tText = useCallback(
    (key: string, options?: Record<string, unknown>) =>
      String(t(key as any, options as any)),
    [t]
  )

  const handleCancelDeleteConfirm = useCallback(() => {
    setShowDeleteConfirm(false)
    setDeleteInputValue('')
    setError('')
  }, [])

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (!table) {
      return
    }

    if (!name.trim()) {
      setError(tText('table:settings.errors.nameRequired'))
      return
    }

    try {
      await updateTable(table.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon || undefined,
      })
      onClose()
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : tText('table:settings.errors.updateFailed')
      )
    }
  }

  const handleDelete = async () => {
    if (!table) {
      return
    }

    if (deleteInputValue !== table.name) {
      setError(tText('table:settings.errors.nameMismatch'))
      return
    }

    const tableName = table.name
    try {
      await deleteTable(table.id)
      onClose()
      // C3 / W1.4:删除表完成后,显示三段式 banner toast
      // 文案:tabdata:table.deletedBanner.title + .description
      // 词表:用「删除」+「停止」+「暂停」(W0-7 边界,不用「回滚」)
      toast({
        title: tText('tabdata:table.deletedBanner.title', { tableName }),
        description: tText('tabdata:table.deletedBanner.description'),
      })
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : tText('table:settings.errors.deleteFailed')
      )
    }
  }

  const handleTrash = async () => {
    if (!table) return
    const tableName = table.name
    try {
      const token = await getAuthToken()
      await adapterApiRequest({
        url: joinApiPath(API_CONFIG.baseURL, `/tabdata/tables/${table.id}/trash`),
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      onClose()
      // C3 / W1.4 + Review P0 修复:三段式 toast
      // - title:「{tableName}」已移到回收站
      // - description:后台计算停止 + Skill/视图暂停 + 30 天恢复入口
      // - action 按钮文案修正:从 common:undo(「撤销/Undo」违反 W0-7 词表)
      //   改为 tabdata:table.trashedBanner.viewTrash(「恢复表格 / Restore table」)
      //   确保动宾语义与「回收站恢复」对齐
      toast({
        title: tText('tabdata:table.trashedBanner.title', { tableName }),
        description: tText('tabdata:table.trashedBanner.description'),
        action: (
          <button
            type="button"
            className="text-body font-medium text-accent hover:underline"
            onClick={async () => {
              try {
                const token2 = await getAuthToken()
                await adapterApiRequest({
                  url: joinApiPath(API_CONFIG.baseURL, `/tabdata/tables/${table.id}/restore-from-trash`),
                  method: 'POST',
                  headers: token2 ? { Authorization: `Bearer ${token2}` } : {},
                })
                toast({ title: tText('table:settings.restoreSuccess') })
              } catch {
                toast({ title: tText('table:settings.restoreFailed'), variant: 'destructive' })
              }
            }}
          >
            {tText('tabdata:table.trashedBanner.restoreAction')}
          </button>
        ),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : tText('table:settings.errors.trashFailed'))
    }
  }

  const handleArchive = async () => {
    if (!table) {
      return
    }

    try {
      await archiveTable(table.id)
      onClose()
    } catch (archiveError) {
      setError(
        archiveError instanceof Error
          ? archiveError.message
          : tText('table:settings.errors.archiveFailed')
      )
    }
  }

  const handleRestore = async () => {
    if (!table) {
      return
    }

    try {
      await restoreTable(table.id)
      onClose()
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : tText('table:settings.errors.restoreFailed')
      )
    }
  }

  if (!table) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={open => { if (!open && !isLoading) onClose() }}>
      <DialogContent className="max-w-lg p-0">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-title font-semibold text-foreground">
                {tText('table:settings.title')}
              </h2>
              <p className="text-body text-muted-foreground">{table.name}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            disabled={isLoading}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <ScrollArea className="max-h-[70vh]"><div className="space-y-6 p-6">
          {!showDeleteConfirm ? (
            <>
              <TableSettingsBasicForm
                t={tText}
                isLoading={isLoading}
                name={name}
                description={description}
                icon={icon}
                iconOptions={ICON_OPTIONS}
                error={error}
                onSubmit={handleUpdate}
                onIconChange={setIcon}
                onNameChange={setName}
                onDescriptionChange={setDescription}
              />

              <TableSettingsDangerZone
                t={tText}
                isLoading={isLoading}
                isArchived={Boolean(table.is_archived)}
                onArchive={handleArchive}
                onRestore={handleRestore}
                onTrash={handleTrash}
                onOpenDeleteConfirm={() => setShowDeleteConfirm(true)}
              />

              {/* W3.5 / D2: 已删除字段入口 */}
              <div className="rounded-lg border border-border p-4">
                <h3 className="text-body font-medium text-foreground mb-2">
                  {tText('tabdata:admin.fieldRecycleBin.title')}
                </h3>
                <p className="text-caption text-muted-foreground mb-3">
                  {tText('tabdata:admin.fieldRecycleBin.description', { days: 30 })}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFieldRecycleBin(true)}
                  disabled={isLoading}
                >
                  {tText('tabdata:admin.fieldRecycleBin.title')}
                </Button>
              </div>

            </>
          ) : (
            <TableSettingsDeleteConfirmPanel
              t={tText}
              isLoading={isLoading}
              tableName={table.name}
              deleteInputValue={deleteInputValue}
              error={error}
              onDeleteInputChange={setDeleteInputValue}
              onCancel={handleCancelDeleteConfirm}
              onConfirmDelete={handleDelete}
            />
          )}
        </div></ScrollArea>
      </DialogContent>

      {/* W3.5 / D2: 字段回收站 */}
      <FieldRecycleBin
        isOpen={showFieldRecycleBin}
        onClose={() => setShowFieldRecycleBin(false)}
        tableId={tableId}
      />

    </Dialog>
  )
}
