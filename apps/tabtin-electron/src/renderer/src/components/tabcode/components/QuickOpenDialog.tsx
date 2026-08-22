/**
 * Quick Open 对话框 (⌘P / Ctrl+P)
 *
 * Fuse.js 驱动的模糊文件搜索：
 * - 默认只模糊匹配文件名；输入路径分隔符时才按相对路径精确匹配
 * - 上下箭头 + Enter 键盘导航（由 cmdk Command 接管）
 * - ESC 关闭（由 Dialog 接管）
 * - 支持预填历史文件列表（⌘E 模式）
 */

import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { useFileSearch, type FileSearchEntry } from '../hooks/useFileSearch'
import { HOTKEYS, hotkeyLabel } from '../utils/hotkeys'
import { basename, relativePath } from '../utils/path'
import { computeHighlightRanges, splitByHighlightRanges } from '../utils/searchHighlight'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  DialogTitle,
  VisuallyHidden,
} from '@components/ui'

const HighlightedText: React.FC<{ text: string; query: string; fuzzy?: boolean }> = ({
  text,
  query,
  fuzzy = true,
}) => {
  const segments = splitByHighlightRanges(text, computeHighlightRanges(text, query, { fuzzy }))
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="rounded-sm bg-primary/15 text-primary-text">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  )
}

interface QuickOpenDialogProps {
  open: boolean
  rootPath: string
  recentFiles?: string[]
  onSelect: (filePath: string) => void
  onClose: () => void
}

export const QuickOpenDialog: React.FC<QuickOpenDialogProps> = ({
  open,
  rootPath,
  recentFiles = [],
  onSelect,
  onClose,
}) => {
  const { t } = useTranslation('tabcode')
  const [searchTerm, setSearchTerm] = useState('')

  const { results: fuseResults, hasQuery, isFetching } = useFileSearch({
    rootPath,
    searchTerm,
    maxResults: 50,
  })

  const displayItems: FileSearchEntry[] = hasQuery
    ? fuseResults.filter(entry => !entry.isDirectory)
    : recentFiles.slice(0, 15).map((p) => ({
        name: basename(p),
        path: p,
        relativePath: relativePath(rootPath, p),
        isDirectory: false,
      }))

  useEffect(() => {
    if (open) setSearchTerm('')
  }, [open])

  const handleSelect = (entry: FileSearchEntry) => {
    if (!entry.isDirectory) {
      onSelect(entry.path)
      onClose()
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose() }}
      commandProps={{ shouldFilter: false, label: t('quickOpen.placeholder') }}
    >
      <VisuallyHidden>
        <DialogTitle>{t('quickOpen.placeholder')}</DialogTitle>
      </VisuallyHidden>
      <div className="relative">
        <CommandInput
          value={searchTerm}
          onValueChange={setSearchTerm}
          placeholder={t('quickOpen.placeholder')}
          autoFocus
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {isFetching && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary/60" />
          )}
          <kbd className="hidden sm:inline-flex items-center rounded border border-border/30 bg-muted/30 px-1.5 py-0.5 text-caption text-muted-foreground/60">
            {hotkeyLabel(HOTKEYS.quickOpen)}
          </kbd>
        </div>
      </div>

      <CommandList>
        {hasQuery && displayItems.length === 0 && !isFetching && (
          <div className="px-4 py-8 text-center text-body text-muted-foreground/40">
            {t('quickOpen.noResults')}
          </div>
        )}

        {!hasQuery && recentFiles.length === 0 && (
          <div className="px-4 py-8 text-center text-body text-muted-foreground/40">
            {t('quickOpen.hint')}
          </div>
        )}

        {displayItems.length > 0 && (
          <CommandGroup heading={!hasQuery ? t('quickOpen.recentFiles') : undefined}>
            {displayItems.map((entry) => (
              <CommandItem
                key={entry.path}
                value={entry.path}
                onSelect={() => handleSelect(entry)}
                className="gap-2"
              >
                <FileIcon
                  fileName={entry.name}
                  isDirectory={entry.isDirectory}
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="truncate font-medium">
                  {hasQuery ? <HighlightedText text={entry.name} query={searchTerm} /> : entry.name}
                </span>
                <span className="ml-auto truncate text-body text-muted-foreground/40 max-w-[50%]">
                  {hasQuery
                    ? <HighlightedText text={entry.relativePath} query={searchTerm} fuzzy={false} />
                    : entry.relativePath}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
