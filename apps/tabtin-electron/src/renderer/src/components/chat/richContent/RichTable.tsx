/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 243-307）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：table_preview kind 渲染 —— 客户端截断 10 行、"展示 X/Y 行"指示、空数据态。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { RichContentBlock } from '@tabtin/chat-client'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { RichFallback } from './RichFallback'

const MAX_TABLE_ROWS = 10

export const RichTablePreview: React.FC<{ block: RichContentBlock }> = React.memo(({ block }) => {
  const { t } = useTranslation('chat')
  const columns = block.columns ?? []
  const rows = block.rows ?? []
  const visibleRows = rows.slice(0, MAX_TABLE_ROWS)
  const totalRows = block.total_rows ?? rows.length

  if (columns.length === 0) {
    return <RichFallback block={block} />
  }

  return (
    <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/30 border-b border-border/20">
        <SidebarTypeEmoji appIdOrType="tabdata" className="h-5 w-5" />
        <p className="text-caption font-medium text-foreground truncate">
          {block.title || t('richContent.tablePreview', '表格预览')}
        </p>
      </div>
      {visibleRows.length === 0 ? (
        <div className="px-3 py-4 text-caption text-muted-foreground text-center">
          {t('richContent.noData')}
        </div>
      ) : (
        <ScrollArea className="max-h-[300px]">
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-border/20">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, ri) => (
                <tr key={ri} className="border-b border-border/10 last:border-0">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className="px-3 py-1 text-foreground max-w-[240px] truncate"
                      title={String(row[col.key] ?? '')}
                    >
                      {String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
      {totalRows > visibleRows.length && (
        <div className="px-3 py-1 bg-muted/20 border-t border-border/20 text-caption text-muted-foreground">
          {t('richContent.showingRows', { shown: visibleRows.length, total: totalRows })}
        </div>
      )}
    </div>
  )
})
