/**
 * 创建组织对话框（展示组件）
 * 纯 UI 组件，通过 props 接收回调
 */

import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Building2 } from 'lucide-react'
import { CreateOrganizationData } from './types'
import { Button } from '../button'
import { Input } from '../input'
import { OVERLAY_SURFACE_CLASS } from '../overlay-surface'
import { t } from "../../i18n"

export interface CreateOrganizationDialogProps {
  /** 是否打开对话框 */
  isOpen: boolean
  /** 是否正在提交 */
  isLoading?: boolean
  /** 错误信息 */
  error?: string | null
  /** 关闭对话框的回调 */
  onClose: () => void
  /** 提交创建的回调 */
  onSubmit: (data: CreateOrganizationData) => Promise<void> | void
  /**
   * 可选头像上传区（由宿主注入，如 Electron 的裁剪上传器）。
   * 放在名称字段上方；不传则不展示头像入口。
   */
  avatarSlot?: React.ReactNode
}

export const CreateOrganizationDialog: React.FC<CreateOrganizationDialogProps> = ({
  isOpen,
  isLoading = false,
  error = null,
  onClose,
  onSubmit,
  avatarSlot,
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [localError, setLocalError] = useState('')

  // 重置表单
  useEffect(() => {
    if (isOpen) {
      setName('')
      setDescription('')
      setLocalError('')
    }
  }, [isOpen])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError('')

    if (!name.trim()) {
      setLocalError(t('organizationDialog.errors.nameRequired'))
      return
    }

    await onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
    })
  }

  const handleClose = () => {
    if (!isLoading) {
      onClose()
    }
  }

  if (!isOpen) return null

  const displayError = error || localError

  return createPortal(
    <>
      {/* z-modal + 实色遮罩：给嵌套裁剪 Dialog 留层，并避免 blur 拖累拖拽 */}
      <div
        className="fixed inset-0 z-modal bg-black/50 animate-in fade-in"
        onClick={handleClose}
      />

      {/* 对话框 */}
      <div className="fixed inset-0 flex items-center justify-center z-modal p-4">
        <div
          className={`${OVERLAY_SURFACE_CLASS} rounded-lg w-full max-w-md overflow-hidden animate-in fade-in`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between p-6 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-title font-semibold text-foreground">
                  {t('organizationDialog.title')}
                </h2>
                <p className="text-body text-muted-foreground">
                  {t('organizationDialog.subtitle')}
                </p>
              </div>
            </div>
            <button
              onClick={handleClose}
              disabled={isLoading}
              className="h-8 w-8 rounded-md hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08] flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t('common.close')}
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* 内容 */}
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {avatarSlot ? (
              <div className="pb-1">
                {avatarSlot}
              </div>
            ) : null}

            {/* 名称 */}
            <div>
              <label className="text-body font-medium text-foreground mb-2 block">
                {t('organizationDialog.nameLabel')} <span className="text-destructive">*</span>
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('organizationDialog.namePlaceholder')}
                maxLength={100}
                disabled={isLoading}
                className="w-full"
              />
              <p className="text-body text-muted-foreground mt-1">
                {t('organizationDialog.charCount', { count: name.length, max: 100 })}
              </p>
            </div>

            {/* 描述 */}
            <div>
              <label className="text-body font-medium text-foreground mb-2 block">
                {t('organizationDialog.descriptionLabel')}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('organizationDialog.descriptionPlaceholder')}
                maxLength={500}
                rows={3}
                disabled={isLoading}
                className="w-full px-3 py-2 bg-muted rounded-md text-body resize-none focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="text-body text-muted-foreground mt-1">
                {t('organizationDialog.charCount', { count: description.length, max: 500 })}
              </p>
            </div>

            {/* 错误提示 */}
            {displayError && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                <p className="text-body text-destructive">{displayError}</p>
              </div>
            )}

            {/* 底部按钮 */}
            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={isLoading}
                className="flex-1"
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !name.trim()}
                className="flex-1"
              >
                {isLoading ? t('organizationDialog.creating') : t('organizationDialog.create')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </>,
    document.body
  )
}
