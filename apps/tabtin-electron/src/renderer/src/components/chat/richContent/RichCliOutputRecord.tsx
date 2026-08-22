/**
 * `cli_output_record` kind 渲染（W4 / D1）—— 把 `tabtin doc read --format json`
 * 等单对象 stdout 自动展示成 key-value 详情卡片。
 *
 * 视觉风格与 `RichCliOutputTable` 对齐（顶部 command header + 边框）；
 * 嵌套对象最多展开 2 层，更深层落到 JSON 字符串预览；数组以 chip 列表展示。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { RichFallback } from './RichFallback'

const MAX_NESTED_DEPTH = 2

function renderPrimitive(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/60">—</span>
  }
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-emerald-500' : 'text-muted-foreground'}>
        {value ? 'true' : 'false'}
      </span>
    )
  }
  if (typeof value === 'number') {
    return <span className="font-mono tabular-nums">{value.toLocaleString()}</span>
  }
  if (typeof value === 'string') {
    if (value === '') return <span className="text-muted-foreground/60">""</span>
    // 长字符串自动 wrap + 等宽（看起来像值，避免误以为是描述文字）
    if (value.length > 80) {
      return (
        <pre className="text-caption font-mono whitespace-pre-wrap break-all bg-muted/20 rounded px-2 py-1 max-h-32 overflow-auto">
          {value}
        </pre>
      )
    }
    return <span className="break-all">{value}</span>
  }
  return <span className="font-mono">{String(value)}</span>
}

function renderArrayChips(arr: unknown[]): React.ReactNode {
  if (arr.length === 0) {
    return <span className="text-muted-foreground/60">[]</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {arr.map((item, i) => {
        const text =
          typeof item === 'object' && item !== null
            ? JSON.stringify(item)
            : String(item)
        return (
          <span
            key={i}
            title={text}
            className="px-1.5 py-0.5 rounded bg-muted/40 text-caption font-mono text-muted-foreground max-w-[200px] truncate"
          >
            {text}
          </span>
        )
      })}
    </div>
  )
}

const ValueCell: React.FC<{ value: unknown; depth: number }> = ({ value, depth }) => {
  if (Array.isArray(value)) {
    // 元素是 plain object 且深度允许 → 折叠 JSON；否则 chip 列表
    const allObject =
      value.length > 0 &&
      value.every((it) => it !== null && typeof it === 'object' && !Array.isArray(it))
    if (allObject && depth < MAX_NESTED_DEPTH) {
      return (
        <pre className="text-caption font-mono whitespace-pre-wrap break-all bg-muted/20 rounded px-2 py-1 max-h-40 overflow-auto">
          {JSON.stringify(value, null, 2)}
        </pre>
      )
    }
    return renderArrayChips(value)
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_NESTED_DEPTH) {
      return (
        <pre className="text-caption font-mono whitespace-pre-wrap break-all bg-muted/20 rounded px-2 py-1 max-h-32 overflow-auto">
          {JSON.stringify(value)}
        </pre>
      )
    }
    return (
      <div className="flex flex-col gap-0.5 border-l-2 border-border/30 pl-2 ml-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <RecordRow key={k} keyName={k} value={v} depth={depth + 1} />
        ))}
      </div>
    )
  }
  return renderPrimitive(value)
}

const RecordRow: React.FC<{ keyName: string; value: unknown; depth: number }> = ({
  keyName,
  value,
  depth,
}) => {
  return (
    <div className="grid grid-cols-[minmax(120px,200px)_1fr] gap-3 py-1 items-start">
      <div
        className="text-caption font-medium text-muted-foreground truncate"
        title={keyName}
      >
        {keyName}
      </div>
      <div className="text-caption text-foreground min-w-0">
        <ValueCell value={value} depth={depth} />
      </div>
    </div>
  )
}

export const RichCliOutputRecord: React.FC<{ block: RichContentBlock }> = React.memo(
  ({ block }) => {
    const { t } = useTranslation('chat')
    const record = block.cli_record
    if (!record || typeof record !== 'object') {
      return <RichFallback block={block} />
    }
    const entries = Object.entries(record)

    return (
      <div className="flex flex-col rounded-lg border border-border/40 overflow-hidden">
        {block.cli_command && (
          <div className="px-3 py-1.5 bg-muted/30 border-b border-border/20 flex items-center gap-2">
            <Terminal className="h-3 w-3 text-muted-foreground/80 shrink-0" />
            <code
              className="text-caption font-mono text-muted-foreground truncate flex-1"
              title={block.cli_command}
            >
              {block.cli_command}
            </code>
          </div>
        )}
        {entries.length === 0 ? (
          <div className="px-3 py-4 text-caption text-muted-foreground text-center">
            {t('richContent.cliEmptyObject', '空对象')}
          </div>
        ) : (
          <div className="px-3 py-2 max-h-[400px] overflow-auto divide-y divide-border/10">
            {entries.map(([k, v]) => (
              <RecordRow key={k} keyName={k} value={v} depth={0} />
            ))}
          </div>
        )}
      </div>
    )
  },
)
