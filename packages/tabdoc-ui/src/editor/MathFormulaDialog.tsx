/**
 * Feishu-style math formula editor:
 * - LaTeX input with live KaTeX preview
 * - Confirm via button / Ctrl(Cmd)+Enter
 * - ESC confirms when there is content (Feishu); empty ESC closes
 */
import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Textarea,
} from '@tabtin/smartsheet-ui'
import { renderMathPreview } from './math-preview'
import 'katex/dist/katex.min.css'

export interface MathFormulaDialogProps {
  open: boolean
  initialLatex?: string
  title: string
  placeholder: string
  previewLabel: string
  previewEmpty: string
  hint: string
  cancelLabel: string
  confirmLabel: string
  onOpenChange: (open: boolean) => void
  onConfirm: (latex: string) => void
}

export function MathFormulaDialog({
  open,
  initialLatex = '',
  title,
  placeholder,
  previewLabel,
  previewEmpty,
  hint,
  cancelLabel,
  confirmLabel,
  onOpenChange,
  onConfirm,
}: MathFormulaDialogProps) {
  const [latex, setLatex] = useState(initialLatex)

  useEffect(() => {
    if (open) setLatex(initialLatex)
  }, [open, initialLatex])

  const preview = useMemo(() => renderMathPreview(latex), [latex])
  const canConfirm = Boolean(latex.trim())

  const handleConfirm = () => {
    const next = latex.trim()
    if (!next) return
    onConfirm(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[520px]"
        onEscapeKeyDown={(event: Event) => {
          if (canConfirm) {
            event.preventDefault()
            handleConfirm()
          }
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <div className="flex flex-col gap-3 pt-2">
          <div className="rounded-md border bg-muted/40 px-3 py-4 min-h-[72px] flex items-center justify-center overflow-x-auto">
            {preview.html ? (
              <div
                className="text-foreground"
                // KaTeX HTML is generated locally from user LaTeX; throwOnError is false.
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            ) : (
              <p className="text-muted-foreground text-body">
                {preview.error ?? previewEmpty}
              </p>
            )}
          </div>
          <p className="text-caption text-muted-foreground -mt-1">{previewLabel}</p>

          <Textarea
            autoFocus
            value={latex}
            placeholder={placeholder}
            className="min-h-[96px] font-mono text-body"
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setLatex(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleConfirm()
              }
            }}
          />
          <p className="text-caption text-muted-foreground">{hint}</p>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button size="sm" onClick={handleConfirm} disabled={!canConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
