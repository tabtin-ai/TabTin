/**
 * LabelManagerDialog — TC-37 label 库管理弹窗
 *
 * 列出当前用户在当前 organization 的 label 库（含每个 label 的会话数），
 * 改名 / 改色 / 删除。
 */

import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Trash2, Loader2, Check, Pencil } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import type { ConversationLabel } from '@/services/tabchatApi'

interface Props {
  isOpen: boolean
  onClose: () => void
}

export const LabelManagerDialog: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('tabchat')
  const labels = useIMStore((s) => s.labels)
  const updateLabel = useIMStore((s) => s.updateLabel)
  const deleteLabel = useIMStore((s) => s.deleteLabel)
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? '')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#6b7280')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const customLabels = labels.filter((l) => !l.is_system)

  const startEdit = useCallback((label: ConversationLabel) => {
    setEditingId(label.id)
    setEditName(label.name)
    setEditColor(label.color)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!editingId) return
    const name = editName.trim()
    if (!name) {
      toast({ title: t('labelNameRequired'), variant: 'destructive' })
      return
    }
    if (name.length > 32) {
      toast({ title: t('labelNameTooLong'), variant: 'destructive' })
      return
    }
    setIsSubmitting(true)
    try {
      await updateLabel(editingId, { name, color: editColor }, organizationId)
      setEditingId(null)
    } catch {
      toast({ title: t('labelUpdateFailed'), variant: 'destructive' })
    } finally {
      setIsSubmitting(false)
    }
  }, [editingId, editName, editColor, updateLabel, organizationId, t])

  const handleDelete = useCallback(async (label: ConversationLabel) => {
    setPendingDeleteId(label.id)
    try {
      await deleteLabel(label.id, organizationId)
      setConfirmDeleteId(null)
    } catch {
      toast({ title: t('labelDeleteFailed'), variant: 'destructive' })
    } finally {
      setPendingDeleteId(null)
    }
  }, [deleteLabel, organizationId, t])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-lg w-[400px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <h2 className="text-subtitle font-semibold text-foreground">{t('labelManage')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hover p-2 space-y-1">
          {customLabels.length === 0 && (
            <p className="px-2 py-4 text-center text-body text-muted-foreground">
              {t('labelEmpty')}
            </p>
          )}
          {customLabels.map((label) => {
            const isEditing = editingId === label.id
            const isConfirmingDelete = confirmDeleteId === label.id
            const isPendingDelete = pendingDeleteId === label.id
            return (
              <div
                key={label.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/30"
              >
                {isEditing ? (
                  <>
                    <input
                      type="color"
                      value={editColor}
                      onChange={(e) => setEditColor(e.target.value)}
                      className="h-6 w-6 rounded border border-border cursor-pointer flex-shrink-0"
                    />
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={32}
                      autoFocus
                      className="flex-1 px-2 py-0.5 text-body rounded border border-border bg-background focus:outline-none focus:border-accent"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSaveEdit()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveEdit()}
                      disabled={isSubmitting}
                      className="h-7 w-7 flex items-center justify-center rounded text-accent hover:bg-accent/10 disabled:opacity-60"
                    >
                      {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:bg-muted/40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      className="h-3 w-3 rounded-full flex-shrink-0 border border-black/10"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1 text-body text-foreground truncate">{label.name}</span>
                    {label.conversation_count !== undefined && label.conversation_count > 0 && (
                      <span className="text-caption text-muted-foreground">
                        {label.conversation_count}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => startEdit(label)}
                      className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/40"
                      title={t('labelName')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {isConfirmingDelete ? (
                      <button
                        type="button"
                        onClick={() => void handleDelete(label)}
                        disabled={isPendingDelete}
                        className="px-2 py-0.5 text-caption rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
                      >
                        {isPendingDelete ? <Loader2 className="h-3 w-3 animate-spin" /> : t('labelDelete')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(label.id)}
                        className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title={t('labelDelete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* 确认删除提示 */}
        {confirmDeleteId && (
          <div className="px-4 py-2 border-t border-border/30 text-caption text-muted-foreground">
            {(() => {
              const label = customLabels.find((l) => l.id === confirmDeleteId)
              if (!label) return null
              const count = label.conversation_count ?? 0
              return count > 0
                ? t('labelDeleteConfirm', { name: label.name, count })
                : t('labelDeleteConfirmNoCount', { name: label.name })
            })()}
          </div>
        )}
      </div>
    </div>
  )
}
