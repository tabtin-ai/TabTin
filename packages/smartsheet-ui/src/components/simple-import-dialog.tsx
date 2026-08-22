import React, { useState } from 'react'
import { Button } from './button'
import { Input } from './input'
import { Label } from './label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from './dialog'
import { t } from "../i18n"

export interface SimpleImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport?: (filePath: string) => Promise<boolean>
  showOpenDialog?: (options: any) => Promise<string[] | undefined>
}

export const SimpleImportDialog: React.FC<SimpleImportDialogProps> = ({
  open,
  onOpenChange,
  onImport,
  showOpenDialog
}) => {
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  const handleSelectFile = async () => {
    if (!showOpenDialog) return

    const filters = [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'Excel Files', extensions: ['xlsx', 'xls'] }
    ]

    try {
      const result = await showOpenDialog({
        filters,
        properties: ['openFile']
      })

      if (result && result.length > 0) {
        setSelectedFile(result[0])
        setError('')
      }
    } catch (err) {
      setError(t('simpleImportDialog.errors.selectFailed'))
    }
  }

  const handleImport = async () => {
    if (!selectedFile) {
      setError(t('simpleImportDialog.errors.noFile'))
      return
    }

    if (!onImport) {
      setError(t('simpleImportDialog.errors.unavailable'))
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const success = await onImport(selectedFile)
      if (success) {
        onOpenChange(false)
        setSelectedFile('')
        setError('')
      } else {
        setError(t('simpleImportDialog.errors.failed'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('simpleImportDialog.errors.failed'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleClose = () => {
    onOpenChange(false)
    setSelectedFile('')
    setError('')
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('simpleImportDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('simpleImportDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="space-y-2">
            <Label>{t('simpleImportDialog.fileLabel')}</Label>
            <div className="flex gap-2">
              <Input
                value={selectedFile}
                placeholder={t('simpleImportDialog.filePlaceholder')}
                readOnly
                className="flex-1"
              />
              <Button onClick={handleSelectFile}>
                {t('simpleImportDialog.browse')}
              </Button>
            </div>
          </div>

          {error && (
            <div className="text-destructive text-body bg-destructive/10 p-3 rounded-md">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleImport}
            disabled={!selectedFile || isLoading}
          >
            {isLoading ? t('simpleImportDialog.importing') : t('simpleImportDialog.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
