import React from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@components/ui'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL, SETTINGS_CONTROL_SM } from './settingsUi'

interface SettingsNameConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  subtitle: string
  items: string[]
  warning: string
  inputLabel: string
  inputPlaceholder: string
  inputValue: string
  onInputChange: (value: string) => void
  expectedValue: string
  error?: string
  isLoading?: boolean
  confirmText: string
  cancelText: string
  onConfirm: () => Promise<void>
}

export const SettingsNameConfirmDialog: React.FC<SettingsNameConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  subtitle,
  items,
  warning,
  inputLabel,
  inputPlaceholder,
  inputValue,
  onInputChange,
  expectedValue,
  error,
  isLoading: _isLoading = false,
  confirmText,
  cancelText,
  onConfirm,
}) => {
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  const nameMatches = inputValue.trim() === expectedValue.trim()
  // 只用 isSubmitting 禁用确认：父级 isLoading 常来自 loadSpaces 等后台刷新，
  // 会把「名称已匹配」的删除按钮误锁死，表现为用户输入正确名称后点击无反应。
  const disabled = isSubmitting || !nameMatches

  const handleConfirm = async () => {
    if (disabled) return
    setIsSubmitting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // keep dialog open to let user fix input or retry
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-subtitle font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-body text-muted-foreground">{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div className="space-y-2">
                <ul className="list-disc space-y-1 pl-4 text-body text-muted-foreground">
                  {items.map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p className="text-body font-semibold text-destructive">{warning}</p>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-body font-medium text-foreground">
              {inputLabel}
            </label>
            <Input
              value={inputValue}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder={inputPlaceholder}
              disabled={isSubmitting}
              className={cn(
                SETTINGS_CONTROL,
                'w-full font-mono',
                inputValue.trim() && !nameMatches && 'border-destructive focus-visible:ring-destructive/30'
              )}
            />
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
              <p className="text-body text-destructive">{error}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className={SETTINGS_CONTROL_SM}
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={disabled}
            className={SETTINGS_CONTROL_SM}
          >
            {isSubmitting ? `${confirmText}...` : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
