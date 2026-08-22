/**
 * TablePaneHeader — 表格页表头组件
 *
 * 对齐 Electron TablePaneHeader 的基本结构：
 * - 返回首页链接
 * - 表格图标、名称、描述
 * - 视图副标题（可选）
 * - 个人视图切换（可选）
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Eye, Loader2, Pencil } from 'lucide-react'

export interface TablePaneHeaderProps {
  tableName?: string
  tableDescription?: string
  tableIcon?: string
  subtitle?: string
  backPath: string
  backTitle: string
  isPersonalViewEnabled: boolean
  showPersonalViewToggle: boolean
  personalViewLabel: string
  personalViewEnableLabel: string
  personalViewDisableLabel: string
  renameTableLabel: string
  onTogglePersonalView: () => void
  onRenameTable?: (name: string) => Promise<boolean>
  isReadonly?: boolean
  isEmbedded?: boolean
}

export const TablePaneHeader: React.FC<TablePaneHeaderProps> = ({
  tableName,
  tableDescription,
  tableIcon = '📄',
  subtitle,
  backPath,
  backTitle,
  isPersonalViewEnabled,
  showPersonalViewToggle,
  personalViewLabel,
  personalViewEnableLabel,
  personalViewDisableLabel,
  renameTableLabel,
  onTogglePersonalView,
  onRenameTable,
  isReadonly = false,
  isEmbedded = false,
}) => {
  const [isEditingName, setIsEditingName] = React.useState(false)
  const [isSavingName, setIsSavingName] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(tableName ?? '')
  const nameInputRef = React.useRef<HTMLInputElement | null>(null)
  const savingNameRef = React.useRef(false)

  React.useEffect(() => {
    if (!isEditingName) setNameDraft(tableName ?? '')
  }, [isEditingName, tableName])

  React.useEffect(() => {
    if (!isEditingName || isSavingName) return
    nameInputRef.current?.focus()
    nameInputRef.current?.select()
  }, [isEditingName, isSavingName])

  const canRename = Boolean(onRenameTable && !isReadonly && !isEmbedded)
  const personalViewActionLabel = isPersonalViewEnabled
    ? personalViewDisableLabel
    : personalViewEnableLabel

  const cancelRename = React.useCallback(() => {
    setNameDraft(tableName ?? '')
    setIsEditingName(false)
  }, [tableName])

  const submitRename = React.useCallback(async () => {
    if (!canRename || !onRenameTable || savingNameRef.current) return
    const nextName = nameDraft.trim()
    if (!nextName || nextName === tableName) {
      cancelRename()
      return
    }

    savingNameRef.current = true
    setIsSavingName(true)
    try {
      const updated = await onRenameTable(nextName)
      if (updated) setIsEditingName(false)
    } finally {
      savingNameRef.current = false
      setIsSavingName(false)
    }
  }, [canRename, cancelRename, nameDraft, onRenameTable, tableName])

  if (isEmbedded && !showPersonalViewToggle) return null

  return (
    <div className="shrink-0 border-b border-border/60 bg-background">
      <div className={isEmbedded ? 'flex h-10 items-center justify-end px-2' : 'flex h-12 items-center gap-3 px-4'}>
        {!isEmbedded && <Link
          to={backPath}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title={backTitle}
        >
          <ArrowLeft className="size-4" />
        </Link>}
        {!isEmbedded && <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/40 text-body">
          {tableIcon}
        </div>}
        {!isEmbedded && <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1">
            {isEditingName ? (
              <input
                ref={nameInputRef}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => void submitRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void submitRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelRename()
                  }
                }}
                enterKeyHint="done"
                disabled={isSavingName}
                aria-label={renameTableLabel}
                className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-body font-semibold text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            ) : (
              <div className="truncate text-body font-semibold text-foreground" title={tableName}>
                {tableName}
              </div>
            )}
            {canRename && !isEditingName ? (
              <button
                type="button"
                onClick={() => setIsEditingName(true)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={renameTableLabel}
                aria-label={renameTableLabel}
              >
                <Pencil className="size-3.5" />
              </button>
            ) : null}
            {isSavingName ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
          </div>
          {tableDescription ? (
            <div className="truncate text-caption text-muted-foreground" title={tableDescription}>
              {tableDescription}
            </div>
          ) : null}
        </div>}

        {!isEmbedded && subtitle && (
          <div className="hidden md:block text-body text-muted-foreground">
            {subtitle}
          </div>
        )}

        {showPersonalViewToggle && (
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-body transition-colors ${
              isPersonalViewEnabled
                ? 'bg-primary/10 text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            onClick={onTogglePersonalView}
            title={personalViewActionLabel}
            aria-label={personalViewActionLabel}
            aria-pressed={isPersonalViewEnabled}
          >
            <Eye className="size-3.5" />
            <span>{personalViewLabel}</span>
          </button>
        )}
      </div>
    </div>
  )
}

TablePaneHeader.displayName = 'TablePaneHeader'
