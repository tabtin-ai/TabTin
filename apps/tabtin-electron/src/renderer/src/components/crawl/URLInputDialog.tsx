import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Label,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/utils/i18n/format'

interface URLInputDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (url: string, name: string) => void
}

export const URLInputDialog: React.FC<URLInputDialogProps> = ({
  open,
  onOpenChange,
  onSubmit,
}) => {
  const { t } = useTranslation('crawl')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // 验证 URL
    if (!url.trim()) {
      setError(t('urlInput.errors.required'))
      return
    }

    // 🆕 URL 自动补全
    let finalUrl = url.trim()

    // 如果没有协议，自动添加 https://
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl
    }

    // 验证 URL 格式
    try {
      const urlObj = new URL(finalUrl)

      // 🆕 使用域名作为默认名称（比时间戳更直观）
      const finalName = name.trim() || urlObj.hostname || t('urlInput.defaultName', {
        time: formatDate(new Date(), { timeStyle: 'medium' })
      })

      onSubmit(finalUrl, finalName)

      // 重置表单
      setUrl('')
      setName('')
      setError('')
      onOpenChange(false)
    } catch {
      setError(t('urlInput.errors.invalid'))
      return
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('urlInput.title')}</DialogTitle>
          <DialogDescription>
            {t('urlInput.description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="url">{t('urlInput.urlLabel')}</Label>
            <Input
              id="url"
              placeholder={t('urlInput.urlPlaceholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setError('')
              }}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">{t('urlInput.nameLabel')}</Label>
            <Input
              id="name"
              placeholder={t('urlInput.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {error && (
            <div className="text-body text-destructive">{error}</div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('urlInput.cancel')}
            </Button>
            <Button type="submit">
              {t('urlInput.create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
