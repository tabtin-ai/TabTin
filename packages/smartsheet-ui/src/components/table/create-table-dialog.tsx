/**
 * 创建表格对话框UI组件
 */

import React, { useState, useEffect } from 'react'
import { Table2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'
import { Button } from '../button'
import { Input } from '../input'
import { Label } from '../label'
import type { CreateTableDialogProps } from './types'
import { t } from "../../i18n"

export const CreateTableDialog: React.FC<CreateTableDialogProps> = ({
  isOpen,
  onClose,
  isLoading,
  error,
  onSubmit,
  organizationId,
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('📊')
  const [nameError, setNameError] = useState('')

  useEffect(() => {
    if (isOpen) {
      setName('')
      setDescription('')
      setIcon('📊')
      setNameError('')
    }
  }, [isOpen])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setNameError('')

    if (!name.trim()) {
      setNameError(t('createTableDialog.errors.nameRequired'))
      return
    }

    if (name.length > 100) {
      setNameError(t('createTableDialog.errors.nameTooLong', { max: 100 }))
      return
    }

    try {
      await onSubmit({
        organization_id: organizationId,
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon || undefined,
      })
      onClose()
    } catch (err) {
      // 错误已经在容器组件中处理
    }
  }

  const iconOptions = ['📊', '📋', '📈', '📉', '📃', '📄', '📑', '🗂️']

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Table2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle>{t('createTableDialog.title')}</DialogTitle>
              <DialogDescription>{t('createTableDialog.description')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 图标选择 */}
          <div className="space-y-2">
            <Label>{t('createTableDialog.iconLabel')}</Label>
            <div className="flex gap-2">
              {iconOptions.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setIcon(emoji)}
                  disabled={isLoading}
                  className={`h-10 w-10 rounded-md flex items-center justify-center text-title transition-all ${
                    icon === emoji
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08]'
                  } disabled:opacity-50`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* 表格名称 */}
          <div className="space-y-2">
            <Label>
              {t('createTableDialog.nameLabel')} <span className="text-destructive">*</span>
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('createTableDialog.namePlaceholder')}
              maxLength={100}
              disabled={isLoading}
            />
            {nameError ? (
              <p className="text-body text-destructive">{nameError}</p>
            ) : (
              <p className="text-body text-muted-foreground">
                {t('createTableDialog.charCount', { count: name.length, max: 100 })}
              </p>
            )}
          </div>

          {/* 描述 */}
          <div className="space-y-2">
            <Label>{t('createTableDialog.descriptionLabel')}</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('createTableDialog.descriptionPlaceholder')}
              maxLength={500}
              rows={3}
              disabled={isLoading}
              className="w-full px-3 py-2 bg-muted rounded-md text-body resize-none focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary/50 disabled:opacity-50"
            />
            <p className="text-body text-muted-foreground">
              {t('createTableDialog.charCount', { count: description.length, max: 500 })}
            </p>
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-body text-destructive">{error}</p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !name.trim()}
            >
              {isLoading ? t('createTableDialog.creating') : t('createTableDialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
