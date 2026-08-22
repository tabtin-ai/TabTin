import React from 'react'
import type { TableGridPagination } from '@tabtin/table-engine'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@tabtin/smartsheet-ui'

export interface DataGridPaginationBarProps {
  currentPage: number
  pageSize: number
  totalCount: number
  isLoading: boolean
  pageSizeOptions?: number[]
  summary: string
  pageSizeLabel: string
  prevLabel: string
  nextLabel: string
  className?: string
  onPaginationChange: (pagination: TableGridPagination) => void | Promise<void>
}

const PAGINATION_VISIBILITY_THRESHOLD = 100

const normalizePageSizeOptions = (pageSize: number, options?: number[]): number[] => {
  const normalized = Array.isArray(options)
    ? options
        .filter(option => Number.isFinite(option) && option > 0)
        .map(option => Math.max(1, Math.floor(option)))
    : []

  if (!normalized.includes(pageSize)) {
    normalized.push(pageSize)
  }

  return Array.from(new Set(normalized)).sort((left, right) => left - right)
}

export const DataGridPaginationBar: React.FC<DataGridPaginationBarProps> = ({
  currentPage,
  pageSize,
  totalCount,
  isLoading,
  pageSizeOptions,
  summary,
  pageSizeLabel,
  prevLabel,
  nextLabel,
  className,
  onPaginationChange,
}) => {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize || 1))
  const normalizedOptions = React.useMemo(
    () => normalizePageSizeOptions(normalizedPageSize, pageSizeOptions),
    [normalizedPageSize, pageSizeOptions]
  )
  const totalPages = Math.max(1, Math.ceil(Math.max(totalCount, 0) / normalizedPageSize))
  const page = Math.max(1, Math.min(currentPage, totalPages))
  const shouldShow = totalCount > PAGINATION_VISIBILITY_THRESHOLD || totalPages > 1
  const shouldShowPageSizeSelector = normalizedOptions.length > 1
  const shouldShowNavigation = totalPages > 1

  const handlePageChange = React.useCallback(
    (nextPage: number) => {
      if (nextPage === page) return
      void onPaginationChange({
        page: nextPage,
        pageSize: normalizedPageSize,
      })
    },
    [normalizedPageSize, onPaginationChange, page]
  )

  const handlePageSizeChange = React.useCallback(
    (value: string) => {
      const nextPageSize = Number.parseInt(value, 10)
      if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === normalizedPageSize) {
        return
      }

      void onPaginationChange({
        page: 1,
        pageSize: nextPageSize,
      })
    },
    [normalizedPageSize, onPaginationChange]
  )

  if (!shouldShow) {
    return null
  }

  return (
    <div
      data-grid-pagination-bar=""
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-background px-4 py-2 text-body text-muted-foreground',
        className
      )}
    >
      <span className="truncate">{summary}</span>
      <div className="flex flex-wrap items-center gap-2">
        {shouldShowPageSizeSelector && (
          <div className="flex items-center gap-2">
            <span className="shrink-0">{pageSizeLabel}</span>
            <Select
              value={String(normalizedPageSize)}
              disabled={isLoading}
              onValueChange={handlePageSizeChange}
            >
              <SelectTrigger className="h-8 w-[88px] bg-background text-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {normalizedOptions.map(option => (
                  <SelectItem key={option} value={String(option)} className="text-body">
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {shouldShowNavigation && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => handlePageChange(page - 1)}
            >
              {prevLabel}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => handlePageChange(page + 1)}
            >
              {nextLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
