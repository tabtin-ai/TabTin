import * as React from "react"
import { cn } from "../utils/cn"
import { Button } from "./button"
import { getSmartsheetUiLocale, t } from "../i18n"

export interface TableInfo {
  id: string
  name: string
  columns: string[]
  rowCount: number
  lastModified?: string
}

export interface TableSelectorProps {
  tables: TableInfo[]
  selectedTableId?: string
  className?: string
  onTableSelect?: (tableId: string) => void
  onTableCreate?: () => void
  onTableEdit?: (tableId: string) => void
  onTableDelete?: (tableId: string) => void
  isLoading?: boolean
}

/**
 * TableSelector 组件 - 用于选择和管理表格
 */
export const TableSelector = React.forwardRef<HTMLDivElement, TableSelectorProps>(
  ({
    tables,
    selectedTableId,
    className,
    onTableSelect,
    onTableCreate,
    onTableEdit,
    onTableDelete,
    isLoading = false,
    ...props
  }, ref) => {
    const formatDate = (dateString?: string) => {
      if (!dateString) return ''
      return new Date(dateString).toLocaleDateString(getSmartsheetUiLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    }

    if (isLoading) {
      return (
        <div className={cn("flex items-center justify-center p-8", className)}>
          <div className="text-muted-foreground">{t('common.loading')}</div>
        </div>
      )
    }

    return (
      <div
        ref={ref}
        className={cn("space-y-2", className)}
        {...props}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-title font-semibold">{t('tableSelector.title')}</h3>
          <Button
            onClick={onTableCreate}
            size="sm"
            className="flex items-center gap-2"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('tableSelector.create')}
          </Button>
        </div>

        {tables.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <svg
              className="h-12 w-12 mx-auto mb-4 opacity-50"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 10h18M3 14h18m-9-4v8m-7 0V8a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
              />
            </svg>
            <p>{t('tableSelector.emptyTitle')}</p>
            <p className="text-body mt-1">{t('tableSelector.emptyDescription')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tables.map((table) => (
              <div
                key={table.id}
                className={cn(
                  "border rounded-lg p-3 cursor-pointer transition-all",
                  "hover:bg-muted/50",
                  selectedTableId === table.id && "ring-2 ring-primary ring-offset-1 bg-muted/30"
                )}
                onClick={() => onTableSelect?.(table.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium truncate">{table.name}</h4>
                    <div className="flex items-center gap-4 mt-1 text-body text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        {t('tableSelector.columnsCount', { count: table.columns.length })}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 6h16M4 10h16M4 14h16M4 18h16"
                          />
                        </svg>
                        {t('tableSelector.rowsCount', { count: table.rowCount })}
                      </span>
                      {table.lastModified && (
                        <span>{t('tableSelector.updatedAt', { date: formatDate(table.lastModified) })}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        onTableEdit?.(table.id)
                      }}
                      className="h-7 w-7 p-0"
                    >
                      <svg
                        className="h-3 w-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        onTableDelete?.(table.id)
                      }}
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    >
                      <svg
                        className="h-3 w-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
)

TableSelector.displayName = "TableSelector"
