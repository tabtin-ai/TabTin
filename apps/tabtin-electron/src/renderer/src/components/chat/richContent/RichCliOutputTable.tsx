/**
 * `cli_output_table` kind 渲染（W4 / D1）—— 把 `tabtin <cmd> --format json`
 * 的 stdout 数组自动展示成结构化 table。
 *
 * 与 `RichTablePreview` 视觉对齐（边框 / 字号 / 截断），但额外：
 *   - 顶部显示原始 command（等宽字体，让用户能复制重跑）
 *   - 类型化单元格渲染：datetime → 相对时间、id → 截断 + tooltip、
 *     boolean → ✓ / ✗、number → 右对齐
 *   - 空数据态："无记录" 卡片
 *   - 大数据集（> 50 行）默认折叠到前 10 行 + "展开全部" 按钮
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Minus, Terminal } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { RichFallback } from './RichFallback'
import { formatRichRelativeTime } from './relativeTime'

const COLLAPSED_ROW_LIMIT = 10
const AUTO_EXPAND_THRESHOLD = 50

type TFn = (key: string, options?: Record<string, unknown>) => string

function truncateMiddle(s: string, max = 16): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

const Cell: React.FC<{ value: unknown; type?: string; t: TFn }> = ({ value, type, t }) => {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground/60">—</span>
  }
  switch (type) {
    case 'boolean':
      return value ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Minus className="h-3.5 w-3.5 text-muted-foreground/60" />
      )
    case 'number':
      return (
        <span className="font-mono tabular-nums">
          {typeof value === 'number' ? value.toLocaleString() : String(value)}
        </span>
      )
    case 'datetime': {
      const s = String(value)
      return (
        <span title={s} className="text-muted-foreground">
          {formatRichRelativeTime(s, t)}
        </span>
      )
    }
    case 'id': {
      const s = String(value)
      return (
        <span title={s} className="font-mono text-caption text-muted-foreground">
          {truncateMiddle(s, 14)}
        </span>
      )
    }
    default: {
      const s =
        typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
      return (
        <span title={s} className="block truncate">
          {s}
        </span>
      )
    }
  }
}

export const RichCliOutputTable: React.FC<{ block: RichContentBlock }> = React.memo(
  ({ block }) => {
    const { t } = useTranslation('chat')
    const columns = block.cli_columns ?? []
    const rows = block.cli_rows ?? []
    const [expanded, setExpanded] = useState(rows.length <= AUTO_EXPAND_THRESHOLD)

    const visibleRows = useMemo(
      () => (expanded ? rows : rows.slice(0, COLLAPSED_ROW_LIMIT)),
      [expanded, rows],
    )

    if (columns.length === 0 && rows.length === 0) {
    return (
      <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
        <CommandHeader command={block.cli_command} t={t} />
        <div className="px-3 py-4 text-caption text-muted-foreground text-center">
          {t('richContent.noData', '无记录')}
        </div>
      </div>
    )
    }

    if (columns.length === 0) {
      return <RichFallback block={block} />
    }

    return (
      <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
        <CommandHeader command={block.cli_command} count={rows.length} t={t} />
        {visibleRows.length === 0 ? (
          <div className="px-3 py-4 text-caption text-muted-foreground text-center">
            {t('richContent.noData', '无记录')}
          </div>
        ) : (
          // 与 W7 RichSearchResults / RichMemoryCard / RichDocumentExcerpt 视觉对齐：
          // 用原生 overflow-auto 替代 @tabtin/smartsheet-ui ScrollArea，
          // 避免 monorepo 测试 build dist 依赖 + 跨组件 scrollbar 风格不一致。
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full text-caption">
              <thead className="sticky top-0 bg-background/95 backdrop-blur">
                <tr className="border-b border-border/20">
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={
                        'px-3 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap ' +
                        (col.type === 'number' ? 'text-right' : '')
                      }
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, ri) => (
                  <tr key={ri} className="border-b border-border/10 last:border-0 hover:bg-muted/20">
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={
                          'px-3 py-1 text-foreground max-w-[240px] ' +
                          (col.type === 'number' ? 'text-right' : '')
                        }
                      >
                        <Cell value={row[col.key]} type={col.type} t={t} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!expanded && rows.length > COLLAPSED_ROW_LIMIT && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-3 py-1.5 bg-muted/20 border-t border-border/20 text-caption text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors text-left"
          >
            {t('richContent.cliExpandAll', {
              defaultValue: '展开全部 {{total}} 行（当前显示前 {{shown}} 行）',
              shown: COLLAPSED_ROW_LIMIT,
              total: rows.length,
            })}
          </button>
        )}
      </div>
    )
  },
)

const CommandHeader: React.FC<{ command?: string; count?: number; t: TFn }> = ({
  command,
  count,
  t,
}) => {
  if (!command) return null
  return (
    <div className="px-3 py-1.5 bg-muted/30 border-b border-border/20 flex items-center gap-2">
      <Terminal className="h-3 w-3 text-muted-foreground/80 shrink-0" />
      <code className="text-caption font-mono text-muted-foreground truncate flex-1" title={command}>
        {command}
      </code>
      {typeof count === 'number' && (
        <span className="text-caption text-muted-foreground/60 tabular-nums shrink-0">
          {t('richContent.cliRowCount', { count })}
        </span>
      )}
    </div>
  )
}
