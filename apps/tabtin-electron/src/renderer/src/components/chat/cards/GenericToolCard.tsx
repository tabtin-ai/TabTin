/**
 * GenericToolCard — Enhanced fallback renderer for tools without a dedicated card.
 *
 * Intelligently renders tool output based on detected data structure:
 * - Array of objects → auto table
 * - Long strings → code block
 * - Nested objects → collapsible key-value pairs
 * - Otherwise → pretty-printed JSON
 *
 * Self-registers as 'GenericToolCard'.
 */

import React, { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import { safeCopyToClipboard } from '../utils/clipboard'
import { ErrorBanner, LoadingPlaceholder, KeyValuePairs } from './primitives'
import type { KeyValueItem } from './primitives'
import {
  CARD_RADIUS,
  CARD_PADDING,
  CARD_HEADER_PADDING,
  CARD_GAP,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { DEBUG_PANELS_ENABLED } from '@/utils/featureFlags'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const MAX_DISPLAY_CHARS = 50_000
const MAX_COPY_CHARS = 5_000_000

function rawStringify(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    const s = JSON.stringify(value, null, 2)
    return s === '{}' || s === '[]' ? null : s
  } catch {
    return String(value)
  }
}

function safeStringify(value: unknown): string | null {
  const raw = rawStringify(value)
  if (!raw) return null
  if (raw.length > MAX_DISPLAY_CHARS) return raw.slice(0, MAX_DISPLAY_CHARS) + '\n... (truncated)'
  return raw
}

function isArrayOfObjects(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) return false
  const allKeys = new Set<string>()
  for (const row of value.slice(0, 5)) {
    for (const k of Object.keys(row as object)) allKeys.add(k)
  }
  return allKeys.size > 0
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * W13（L-24）：识别 jsonError envelope —— `{ success: false, error: string, ... }`。
 * 形态由 capability 层 `jsonError(message, metadata)` 统一构造，metadata 字段散落
 * 在顶层（如 `error_kind` / `pattern` / `cwd` / `http_status` / `data` 等）。
 *
 * 不强求 `error_kind` 存在：W12 / W13 之前部分调用点可能只有 `success: false`
 * 与 `error`，仍按 envelope 处置——只要不是 jsonError 真正的 contract，就 fallback
 * 回原渲染。
 */
function isJsonErrorEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).success === false &&
    typeof (value as Record<string, unknown>).error === 'string'
  )
}

/** envelope 顶层字段，渲染时排除（已经在 ErrorBanner 里展示）。 */
const ENVELOPE_RESERVED_KEYS = new Set(['success', 'error'])

function extractJsonErrorText(value: unknown): string | null {
  const parsed = parseJsonString(value)
  return isJsonErrorEnvelope(parsed) && typeof parsed.error === 'string' ? parsed.error : null
}

/* ─── Sub-components ──────────────────────────────────────────────── */

const AutoTable: React.FC<{ data: Array<Record<string, unknown>>; moreLabel: (remaining: number) => string }> = React.memo(({ data, moreLabel }) => {
  const columns = useMemo(() => {
    const colSet = new Set<string>()
    for (const row of data.slice(0, 20)) {
      for (const k of Object.keys(row)) colSet.add(k)
    }
    return Array.from(colSet)
  }, [data])

  const MAX_ROWS = 20

  return (
    <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="both">
      <table className={cn(TEXT.code, 'w-full border-collapse')}>
        <thead>
          <tr className={cn(BG.header, 'border-b', BORDER.subtle)}>
            {columns.map((col) => (
              <th
                key={col}
                className={cn(
                  'text-left px-2 py-1',
                  TEXT.label,
                  TEXT_COLOR.muted,
                  'whitespace-nowrap',
                )}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, MAX_ROWS).map((row, i) => (
            <tr key={i} className={cn('border-b', BORDER.subtle, 'hover:bg-muted/5')}>
              {columns.map((col) => (
                <td
                  key={col}
                  className={cn('px-2 py-0.5', TEXT_COLOR.secondary, 'whitespace-nowrap max-w-[200px] truncate')}
                  title={String(row[col] ?? '')}
                >
                  {row[col] === null || row[col] === undefined
                    ? 'null'
                    : typeof row[col] === 'object'
                    ? (() => { try { return JSON.stringify(row[col]) } catch { return '[Object]' } })()
                    : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > MAX_ROWS && (
        <div className={cn('px-2 py-1', TEXT.meta, TEXT_COLOR.faint, 'italic')}>
          {moreLabel(data.length - MAX_ROWS)}
        </div>
      )}
    </ScrollArea>
  )
})
AutoTable.displayName = 'AutoTable'

/**
 * 折叠/展开块。默认渲染 pre 文本；W13 起支持 `renderBody` 注入自定义 body
 * （例如 KeyValuePairs 把 metadata 字段以结构化方式呈现，而不是 raw JSON 文本）。
 *
 * `value` 用于：(1) 短文本场景下直接 inline 显示；(2) lines 数统计；(3) 长文本
 * 默认 fallback。`renderBody` 仅在展开后接管 body 渲染。
 *
 * `forceCollapsible`: 即使内容很短也强制走折叠模式（W13 「错误详情」分区希望一律
 * 折叠以避免抢占 banner 视觉焦点）。
 */
const CollapsibleObject: React.FC<{
  label: string
  value: string
  linesLabel: string
  renderBody?: () => React.ReactNode
  forceCollapsible?: boolean
}> = React.memo(
  ({ label, value, linesLabel, renderBody, forceCollapsible }) => {
    const [open, setOpen] = useState(false)
    const lines = value.split('\n').length
    const isLong = lines > 5 || value.length > 300

    if (!isLong && !forceCollapsible && !renderBody) {
      return (
        <pre
          className={cn(
            CARD_PADDING.x,
            'py-1.5',
            TEXT.code,
            TEXT_COLOR.secondary,
            'whitespace-pre-wrap break-all',
          )}
        >
          {value}
        </pre>
      )
    }

    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex items-center gap-1 w-full',
            CARD_PADDING.x,
            'py-1',
            TEXT.meta,
            TEXT_COLOR.muted,
            'hover:bg-muted/10',
          )}
        >
          {open ? <ChevronDown className={ICON_SIZE.sm} /> : <ChevronRight className={ICON_SIZE.sm} />}
          <span>{label}</span>
          {!renderBody && (
            <span className={TEXT_COLOR.faint}>({lines} {linesLabel})</span>
          )}
        </button>
        {open && (
          renderBody ? (
            <div>{renderBody()}</div>
          ) : (
            <ScrollArea className={CARD_MAX_HEIGHT.md} scrollBar="both">
              <pre
                className={cn(
                  CARD_PADDING.x,
                  'py-1.5',
                  TEXT.code,
                  TEXT_COLOR.secondary,
                  'whitespace-pre-wrap break-all',
                )}
              >
                {value}
              </pre>
            </ScrollArea>
          )
        )}
      </div>
    )
  },
)
CollapsibleObject.displayName = 'CollapsibleObject'

/* ─── Main component ──────────────────────────────────────────────── */

const GenericToolCard: React.FC<CardRendererProps> = React.memo(
  ({ input, output, error, phase }) => {
    const { t } = useTranslation('chat')
    const [copied, setCopied] = useState(false)

    const parsedOutput = useMemo(() => parseJsonString(output), [output])
    const parsedInput = useMemo(() => parseJsonString(input), [input])
    const normalizedError = useMemo(() => extractJsonErrorText(error) || error, [error])

    // W13（L-24）：识别 jsonError envelope。识别后走"语义化错误"分支：
    //   1. ErrorBanner 用上层翻译过的 `error` 字符串（toolLifecycleNotice.translateToolErrorKind）
    //   2. metadata 字段（除 success / error）用 KeyValuePairs 展开成结构化二级区块
    //   3. raw JSON 仅作为「查看详情」折叠项（用于排查）
    // 非 jsonError shape（包括 isError + 非 envelope 字符串）走原 fallback 渲染。
    const isErrorPhase = phase === 'error'
    const errorEnvelope = isErrorPhase && isJsonErrorEnvelope(parsedOutput) ? parsedOutput : null
    // envelope 优先：error banner 文案优先用 toolHandler 翻译过的 error 字符串；
    // 没有翻译时（前置 i18n 缺失）fallback 到 envelope.error 原文。
    const envelopeErrorText = errorEnvelope
      ? normalizedError || (typeof errorEnvelope.error === 'string' ? errorEnvelope.error : null)
      : null
    const envelopeMetadataItems: KeyValueItem[] = useMemo(() => {
      if (!errorEnvelope) return []
      return Object.entries(errorEnvelope)
        .filter(([k, v]) => !ENVELOPE_RESERVED_KEYS.has(k) && v !== undefined && v !== null && v !== '')
        .map(([key, value]) => ({ key, value }))
    }, [errorEnvelope])
    const envelopeRawJson = useMemo(
      () => (errorEnvelope ? safeStringify(errorEnvelope) : null),
      [errorEnvelope],
    )

    const unwrappedOutput = useMemo(() => {
      if (parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput)) {
        const obj = parsedOutput as Record<string, unknown>
        if ('data' in obj && obj.data !== undefined) return obj.data
      }
      return parsedOutput
    }, [parsedOutput])

    const isTable = isArrayOfObjects(unwrappedOutput)
    const inputStr = safeStringify(parsedInput)
    // jsonError envelope 不再走 Result 区块——相同 JSON 既显示在 error banner / metadata
    // 又显示在 Result 是冗余信息（W13 dogfood review 痛点）
    const outputStr = isTable || errorEnvelope ? null : safeStringify(unwrappedOutput)
    const hasResultBody = !!(outputStr || isTable)
    // 工具错误改由 Agent 处置：仅当 DEBUG 面板开启时，error 内容才贡献到 hasContent；
    // 否则"只有 error 没有其他内容"的卡片不再渲染空壳——保持主流干净。
    const hasErrorContent = !!(normalizedError || errorEnvelope)
    const hasContent = !!(inputStr || hasResultBody || (hasErrorContent && DEBUG_PANELS_ENABLED))

    const isTruncated = useMemo(() => {
      const raw = rawStringify(unwrappedOutput)
      return raw !== null && raw.length > MAX_DISPLAY_CHARS
    }, [unwrappedOutput])

    const handleCopy = useCallback(() => {
      const raw = rawStringify(unwrappedOutput) ?? ''
      const text = raw.length > MAX_COPY_CHARS
        ? raw.slice(0, MAX_COPY_CHARS) + '\n... (copy limit reached)'
        : raw
      safeCopyToClipboard(text, () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    }, [unwrappedOutput])

    // 所有 hooks 调用之后，再做条件性早期 return（保持原渲染优先级：phase=='start' && !output 优先）
    if ((phase === 'start' || phase === 'running') && !output) return <LoadingPlaceholder />
    if (!hasContent) return <div className="text-body text-muted-foreground/60 px-3 py-2">{t('card.generic_no_content')}</div>

    return (
      <div className={cn('overflow-hidden', CARD_GAP)}>
        {/* Parameters */}
        {inputStr && (
          <div>
            <div
              className={cn(
                CARD_HEADER_PADDING.x,
                'py-1',
                TEXT.label,
                TEXT_COLOR.muted,
                BG.header,
                'border-b',
                BORDER.subtle,
              )}
            >
              {t('card.generic_params')}
            </div>
            <CollapsibleObject label={t('card.generic_params')} value={inputStr} linesLabel={t('card.lines_unit')} />
          </div>
        )}

        {/* Result — auto table or text. jsonError envelope 走专属分支，不重复渲染 JSON。 */}
        {hasResultBody && (
          <div className={cn(inputStr ? 'border-t' : '', inputStr ? BORDER.subtle : '')}>
            <div
              className={cn(
                'flex items-center gap-1.5',
                CARD_HEADER_PADDING.x,
                'py-1',
                TEXT.label,
                TEXT_COLOR.muted,
                BG.header,
                'border-b',
                BORDER.subtle,
              )}
            >
              <span className="flex-1">
                {t('card.generic_result')}
                {isTable && (
                  <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-1')}>
                    ({(unwrappedOutput as unknown[]).length} rows)
                  </span>
                )}
              </span>
              <ChatIconTooltip content={isTruncated ? t('card.generic_copy_full') : t('card.generic_copy_result')}>
                <button
                  type="button"
                  onClick={handleCopy}
                  className={cn(
                    'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
                    TEXT_COLOR.muted,
                  )}
                  aria-label={isTruncated ? t('card.generic_copy_full') : t('card.generic_copy_result')}
                >
                  {copied ? (
                    <Check className={cn(ICON_SIZE.sm, TEXT_COLOR.success)} />
                  ) : (
                    <Copy className={ICON_SIZE.sm} />
                  )}
                </button>
              </ChatIconTooltip>
            </div>
            {isTable ? (
              <AutoTable data={unwrappedOutput as Array<Record<string, unknown>>} moreLabel={(n) => `... ${t('card.more_rows', { count: n })}`} />
            ) : (
              <CollapsibleObject label={t('card.generic_result')} value={outputStr!} linesLabel={t('card.lines_unit')} />
            )}
          </div>
        )}

        {/*
         * Error 段——专题《工具错误改由 Agent 处置》（2026-05-09）：
         * 整段 gate 到 DEBUG_PANELS_ENABLED。错误处理权交给 Agent：
         *   - 用户视角：默认看不到 raw 错误（包括 banner / "错误详情" / "查看原始 JSON" 折叠条），
         *     由 Agent 用人话告知处境和需要的协助；
         *   - 开发者视角：dev 模式默认展示；packaged build 需
         *     VITE_ENABLE_DEBUG_PANELS=true，便于排查。
         */}
        {DEBUG_PANELS_ENABLED && (errorEnvelope ? (
          <div
            className={cn(
              (inputStr || hasResultBody) ? 'border-t' : '',
              (inputStr || hasResultBody) ? BORDER.error : '',
            )}
          >
            <ErrorBanner error={envelopeErrorText} forceShow />
            {envelopeMetadataItems.length > 0 && (
              <CollapsibleObject
                label={t('card.generic_error_details', { defaultValue: '错误详情 / Error details' })}
                value={JSON.stringify(
                  Object.fromEntries(envelopeMetadataItems.map((it) => [it.key, it.value])),
                  null,
                  2,
                )}
                linesLabel={t('card.lines_unit')}
                renderBody={() => <KeyValuePairs items={envelopeMetadataItems} />}
              />
            )}
            {envelopeRawJson && (
              <CollapsibleObject
                label={t('card.generic_view_raw', { defaultValue: '查看原始 JSON / View raw JSON' })}
                value={envelopeRawJson}
                linesLabel={t('card.lines_unit')}
                forceCollapsible
              />
            )}
          </div>
        ) : (
          normalizedError && (
            <div className={cn((inputStr || hasResultBody) ? 'border-t' : '', (inputStr || hasResultBody) ? BORDER.error : '')}>
              <ErrorBanner error={normalizedError} forceShow />
            </div>
          )
        ))}
      </div>
    )
  },
)

GenericToolCard.displayName = 'GenericToolCard'

const GenericToolCardRenderer = GenericToolCard

registerCardRenderer('GenericToolCard', GenericToolCardRenderer)

export { GenericToolCard, GenericToolCardRenderer }
export default GenericToolCard
