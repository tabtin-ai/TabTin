import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Table } from '@tabtin/table-core'
import type { TableField, ViewMeta } from '@tabtin/table-ui'

type GridRow = Record<string, unknown> & {
  id: string
  __rowType?: string
  __groupLabel?: string
  __groupCount?: number
  __groupLevel?: number
}

export interface TableHostDataPreviewCardProps {
  hasAccessToken: boolean
  isBusy: boolean
  error: string | null
  tables: Table[]
  selectedTableId: string
  selectedViewId: string | null
  views: ViewMeta[]
  selectedTable: Table | null
  orderedFields: TableField[]
  displayRows: GridRow[]
  selectedRecordId: string | null
  onSelectTable: (tableId: string) => void
  onSelectView: (viewId: string | null) => void
  onSelectRecord: (recordId: string) => void
  formatCellValue: (value: unknown, fieldType: string) => string
}

export function TableHostDataPreviewCard({
  hasAccessToken,
  isBusy,
  error,
  tables,
  selectedTableId,
  selectedViewId,
  views,
  selectedTable,
  orderedFields,
  displayRows,
  selectedRecordId,
  onSelectTable,
  onSelectView,
  onSelectRecord,
  formatCellValue,
}: TableHostDataPreviewCardProps) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="text-subtitle">表格数据预览</CardTitle>
        <CardDescription>
          当前使用 `useViewContainerState + useDataGridDataset` 做视图判定与网格数据组装。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-body text-muted-foreground">Table</div>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-body"
              value={selectedTableId}
              onChange={(event) => onSelectTable(event.target.value)}
              disabled={!hasAccessToken || isBusy || tables.length === 0}
            >
              <option value="">请选择表格</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <div className="text-body text-muted-foreground">View</div>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-body"
              value={selectedViewId ?? ''}
              onChange={(event) => onSelectView(event.target.value || null)}
              disabled={!hasAccessToken || !selectedTableId || views.length === 0}
            >
              <option value="">默认记录流（table records）</option>
              {views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name} ({view.view_type})
                </option>
              ))}
            </select>
          </div>
        </div>

        {!hasAccessToken && (
          <div className="rounded-md border bg-background px-3 py-6 text-body text-muted-foreground">
            登录态已失效，请先重新登录。
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {hasAccessToken && isBusy && (
          <div className="rounded-md border bg-background px-3 py-6 text-body text-muted-foreground">
            正在加载表格数据...
          </div>
        )}

        {hasAccessToken && !isBusy && !selectedTable && (
          <div className="rounded-md border bg-background px-3 py-6 text-body text-muted-foreground">
            请选择组织/Space 并加载表格。
          </div>
        )}

        {hasAccessToken && !isBusy && selectedTable && orderedFields.length === 0 && (
          <div className="rounded-md border bg-background px-3 py-6 text-body text-muted-foreground">
            当前表暂无可展示字段。
          </div>
        )}

        {hasAccessToken && !isBusy && selectedTable && orderedFields.length > 0 && (
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-full text-body">
              <thead className="bg-muted/40">
                <tr>
                  {orderedFields.map((field) => (
                    <th
                      key={field.id}
                      className="border-b px-3 py-2 text-left font-medium text-foreground"
                    >
                      {field.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={Math.max(orderedFields.length, 1)}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      当前无记录
                    </td>
                  </tr>
                )}
                {displayRows.map((row) => {
                  if (row.__rowType === 'group_header') {
                    const groupLabel = String(row.__groupLabel ?? '分组')
                    const groupCount = Number(row.__groupCount ?? 0)
                    const groupLevel = Number(row.__groupLevel ?? 0)

                    return (
                      <tr key={row.id} className="bg-muted/20">
                        <td
                          colSpan={orderedFields.length}
                          className="border-b px-3 py-2 text-body font-medium"
                        >
                          <span style={{ paddingLeft: `${groupLevel * 12}px` }}>
                            {groupLabel} ({groupCount})
                          </span>
                        </td>
                      </tr>
                    )
                  }

                  const rowId = String(row.id)
                  const isSelected = selectedRecordId === rowId

                  return (
                    <tr
                      key={rowId}
                      className={cn(
                        'cursor-pointer hover:bg-muted/20',
                        isSelected && 'bg-primary/10 hover:bg-primary/10'
                      )}
                      onClick={() => onSelectRecord(rowId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelectRecord(rowId)
                        }
                      }}
                      tabIndex={0}
                    >
                      {orderedFields.map((field) => {
                        const raw = row[field.name]
                        const text = formatCellValue(raw, String(field.field_type))
                        return (
                          <td key={`${rowId}-${field.id}`} className="border-b px-3 py-2 align-top">
                            <div className="max-w-[280px] truncate" title={text}>
                              {text || '-'}
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
