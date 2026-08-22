/**
 * Smart Field List - 智能字段列表组件
 * 支持区分公共字段变化和类型特有字段
 */

import { Button } from '@/components/ui/button'
import { FieldLabel } from '@/components/ui/field-label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { DiffResult, SmartDiffResult } from '@/utils/objectDiff'
import { Check, ChevronDown, ChevronRight, Copy, Eye, FileCode, GitCompare, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { SkeletonViewerModal } from './skeleton-viewer-modal'

// 重要字段排序
const IMPORTANT_FIELDS = [
  'url',
  'status',
  'mode',
  'next',
  'decision',
  'content',
  'messages',
  'model',
  'result',
  'error',
  'success',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getSkeletonPayload(value: unknown): { html: string; url: string; title?: string } | null {
  if (!isRecord(value) || typeof value.html !== 'string') {
    return null
  }

  return {
    html: value.html,
    url: typeof value.url === 'string' ? value.url : 'Unknown',
    title: typeof value.title === 'string' ? value.title : undefined,
  }
}

function sortFieldsByImportance(fields: string[], diffMap?: Map<string, DiffResult>): string[] {
  return fields.sort((a, b) => {
    // 1. 优先显示有变化的字段（如果提供了 diffMap）
    if (diffMap) {
      const aDiff = diffMap.get(a)
      const bDiff = diffMap.get(b)
      const aChanged = aDiff && aDiff.type !== 'unchanged'
      const bChanged = bDiff && bDiff.type !== 'unchanged'

      if (aChanged && !bChanged) return -1
      if (!aChanged && bChanged) return 1
    }

    // 2. 按重要字段顺序排序
    const aIndex = IMPORTANT_FIELDS.indexOf(a)
    const bIndex = IMPORTANT_FIELDS.indexOf(b)

    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex
    if (aIndex !== -1) return -1
    if (bIndex !== -1) return 1

    // 3. 字母顺序
    return a.localeCompare(b)
  })
}

// 判断是否是简单值
function isSimpleValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'boolean' || typeof value === 'number') return true
  if (typeof value === 'string' && value.length <= 80) return true
  return false
}

// 可折叠的小节
function CollapsibleSection({
  title,
  defaultExpanded = false,
  children,
  count,
}: {
  title: string
  defaultExpanded?: boolean
  children: React.ReactNode
  count?: number
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center justify-between px-0 py-2 text-left hover:text-foreground transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-body font-semibold text-muted-foreground">{title}</span>
          {count !== undefined && (
            <span className="text-body text-muted-foreground/60">({count})</span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {isExpanded && <div className="pb-3">{children}</div>}
    </div>
  )
}

// 简单字段项
function SimpleFieldItem({
  fieldKey,
  value,
  diff,
}: { fieldKey: string; value: unknown; diff?: DiffResult }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(String(value))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const renderValue = () => {
    if (value === null) return <span className="text-muted-foreground italic">null</span>
    if (value === undefined) return <span className="text-muted-foreground italic">undefined</span>
    if (typeof value === 'boolean') return <span className="text-info">{String(value)}</span>
    if (typeof value === 'number') return <span className="text-success">{value}</span>
    return <span className="text-body truncate max-w-[150px]">"{String(value)}"</span>
  }

  // Diff 样式
  const diffStyles = useMemo(() => {
    if (!diff || diff.type === 'unchanged') return 'bg-muted/30 border-muted/30'
    if (diff.type === 'added') return 'bg-info/10 border-info/30'
    if (diff.type === 'modified') return 'bg-warning/10 border-warning/30'
    if (diff.type === 'deleted')
      return 'bg-muted-foreground/10 border-muted-foreground/30 opacity-60'
    return 'bg-muted/30 border-muted/30'
  }, [diff])

  // Diff 图标
  const diffIcon = useMemo(() => {
    if (!diff || diff.type === 'unchanged')
      return <span className="text-muted-foreground/60 text-caption font-bold mr-1">=</span>
    if (diff.type === 'added')
      return <span className="text-info text-caption font-bold mr-1">+</span>
    if (diff.type === 'modified')
      return <span className="text-warning text-caption font-bold mr-1">~</span>
    if (diff.type === 'deleted')
      return <span className="text-muted-foreground text-caption font-bold mr-1">-</span>
    return null
  }, [diff])

  return (
    <div
      className={cn(
        'group inline-flex items-center gap-1 rounded-md px-2 py-1 border hover:bg-muted/50 transition-colors',
        diffStyles
      )}
    >
      {diffIcon}
      <FieldLabel fieldKey={fieldKey} showEnglish className="text-caption font-medium" />
      <span className="text-caption text-muted-foreground">:</span>

      {diff?.type === 'modified' ? (
        <div className="flex items-center gap-1 text-caption">
          <span className="text-muted-foreground line-through max-w-[60px] truncate">
            {String(diff.oldValue).substring(0, 15)}
          </span>
          <span className="text-warning">→</span>
          {renderValue()}
        </div>
      ) : (
        renderValue()
      )}

      <button
        type="button"
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 transition-opacity ml-1"
      >
        {copied ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        )}
      </button>
    </div>
  )
}

// 复杂字段项
function ComplexFieldItem({
  fieldKey,
  value,
  diff,
}: { fieldKey: string; value: unknown; diff?: DiffResult }) {
  const [copied, setCopied] = useState(false)
  const [copiedJson, setCopiedJson] = useState(false)
  const [showSkeletonModal, setShowSkeletonModal] = useState(false)
  const [showJsonModal, setShowJsonModal] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(
      typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(value, null, 2))
    setCopiedJson(true)
    setTimeout(() => setCopiedJson(false), 2000)
  }

  const skeletonPayload = fieldKey === 'skeleton' ? getSkeletonPayload(value) : null

  const diffStyles = useMemo(() => {
    if (!diff || diff.type === 'unchanged') return 'bg-muted/30'
    if (diff.type === 'added') return 'bg-info/10 border border-info/30'
    if (diff.type === 'modified') return 'bg-warning/10 border border-warning/30'
    if (diff.type === 'deleted')
      return 'bg-muted-foreground/10 border border-muted-foreground/30 opacity-60'
    return 'bg-muted/30'
  }, [diff])

  const diffBadge = useMemo(() => {
    if (!diff || diff.type === 'unchanged') return null
    if (diff.type === 'added')
      return (
        <span className="inline-flex items-center text-caption text-info font-bold">
          <span className="mr-0.5">+</span>新增
        </span>
      )
    if (diff.type === 'modified')
      return (
        <span className="inline-flex items-center text-caption text-warning font-bold">
          <span className="mr-0.5">~</span>已修改
        </span>
      )
    if (diff.type === 'deleted')
      return (
        <span className="inline-flex items-center text-caption text-muted-foreground font-bold">
          <span className="mr-0.5">-</span>上游特有
        </span>
      )
    return null
  }, [diff])

  const renderValue = () => {
    if (skeletonPayload) {
      const htmlSize = new Blob([skeletonPayload.html]).size / 1024
      return (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-body">
            Skeleton HTML ({htmlSize.toFixed(1)} KB)
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-caption"
            onClick={() => setShowSkeletonModal(true)}
          >
            <FileCode className="mr-1 h-3 w-3" />
            打开
          </Button>
        </div>
      )
    }

    if (Array.isArray(value)) {
      return (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-body">Array ({value.length})</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-caption"
            onClick={() => setShowJsonModal(true)}
          >
            <Eye className="mr-1 h-3 w-3" />
            查看
          </Button>
        </div>
      )
    }

    if (isRecord(value)) {
      const keys = Object.keys(value)
      return (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-body">Object ({keys.length} keys)</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-caption"
            onClick={() => setShowJsonModal(true)}
          >
            <Eye className="mr-1 h-3 w-3" />
            查看
          </Button>
        </div>
      )
    }

    const strValue = String(value)
    return (
      <div className="flex items-center gap-2">
        <span className="text-body break-all line-clamp-1">{strValue}</span>
        {strValue.length > 100 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-caption flex-shrink-0"
            onClick={() => setShowJsonModal(true)}
          >
            展开
          </Button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className={cn('flex items-start gap-2 rounded-md p-2 group text-body', diffStyles)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <FieldLabel fieldKey={fieldKey} showEnglish className="text-caption font-medium" />
            {diffBadge}
          </div>
          {diff?.type === 'modified' && (
            <div className="text-caption text-muted-foreground mb-0.5 line-through">
              旧: {JSON.stringify(diff.oldValue).substring(0, 40)}...
            </div>
          )}
          <div>{renderValue()}</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>

      {skeletonPayload && showSkeletonModal && (
        <SkeletonViewerModal
          isOpen={showSkeletonModal}
          onClose={() => setShowSkeletonModal(false)}
          skeleton={skeletonPayload}
        />
      )}

      {showJsonModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8"
          onClick={() => setShowJsonModal(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setShowJsonModal(false)
            }
          }}
        >
          <div
            className="bg-background rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="font-semibold text-body">
                <FieldLabel fieldKey={fieldKey} showEnglish />
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyJson}
                  className="h-7 text-body"
                >
                  {copiedJson ? (
                    <>
                      <Check className="mr-1 h-3 w-3" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-3 w-3" />
                      Copy
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowJsonModal(false)}
                  className="h-7 w-7"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <ScrollArea className="flex-1 p-4">
              <pre className="text-caption font-mono whitespace-pre-wrap">
                {JSON.stringify(value, null, 2)}
              </pre>
            </ScrollArea>
          </div>
        </div>
      )}
    </>
  )
}

// 主组件
export function SmartFieldList({
  data,
  smartDiff,
  showTopN = 5,
  enableShowMore = true,
}: {
  data: Record<string, unknown>
  smartDiff?: SmartDiffResult
  showTopN?: number
  enableShowMore?: boolean
}) {
  // ⚠️ 所有 Hooks 必须在最顶部，不能在条件语句中调用
  const [showAll, setShowAll] = useState(false)
  const [showOnlyCommon, setShowOnlyCommon] = useState(false)
  const [showOnlyChanges, setShowOnlyChanges] = useState(false)

  // 简单模式数据（没有 smartDiff）
  const simpleMode = useMemo(() => {
    if (smartDiff) return null

    const allFields = sortFieldsByImportance(Object.keys(data))
    const simpleFields = allFields.filter((key) => isSimpleValue(data[key]))
    const complexFields = allFields.filter((key) => !isSimpleValue(data[key]))

    const visibleSimple = showAll ? simpleFields : simpleFields.slice(0, showTopN)
    const visibleComplex = showAll
      ? complexFields
      : complexFields.slice(0, Math.max(0, showTopN - visibleSimple.length))
    const hasMore = simpleFields.length + complexFields.length > showTopN

    return { simpleFields, complexFields, visibleSimple, visibleComplex, hasMore }
  }, [data, smartDiff, showAll, showTopN])

  // 智能 Diff 模式数据
  const diffMode = useMemo(() => {
    if (!smartDiff) return null

    const { commonFieldsDiff, typeSpecificOld, typeSpecificNew, oldValues, newValues } = smartDiff

    // 公共字段分类 - 使用改进的排序，优先显示有变化的字段
    let fields = Array.from(commonFieldsDiff.keys())
    if (showOnlyChanges) {
      fields = fields.filter((key) => commonFieldsDiff.get(key)?.type === 'modified')
    }
    fields = sortFieldsByImportance(fields, commonFieldsDiff)

    const commonSimple = fields.filter((key) => isSimpleValue(data[key]))
    const commonComplex = fields.filter((key) => !isSimpleValue(data[key]))

    // 上游特有字段分类
    const oldFields = sortFieldsByImportance(typeSpecificOld)
    const oldSimple = oldFields.filter((key) => isSimpleValue(oldValues[key]))
    const oldComplex = oldFields.filter((key) => !isSimpleValue(oldValues[key]))

    // 当前特有字段分类
    const newFields = sortFieldsByImportance(typeSpecificNew)
    const newSimple = newFields.filter((key) => isSimpleValue(newValues[key]))
    const newComplex = newFields.filter((key) => !isSimpleValue(newValues[key]))

    // 统计
    const changedCount = Array.from(commonFieldsDiff.values()).filter(
      (d) => d.type === 'modified'
    ).length
    const unchangedCount = Array.from(commonFieldsDiff.values()).filter(
      (d) => d.type === 'unchanged'
    ).length

    return {
      commonFieldsDiff,
      typeSpecificOld,
      typeSpecificNew,
      oldValues,
      newValues,
      commonFields: { simple: commonSimple, complex: commonComplex, all: fields },
      oldSpecificFields: { simple: oldSimple, complex: oldComplex },
      newSpecificFields: { simple: newSimple, complex: newComplex },
      changedCount,
      unchangedCount,
    }
  }, [smartDiff, data, showOnlyChanges])

  // 渲染简单模式
  if (simpleMode) {
    const { visibleSimple, visibleComplex, hasMore, simpleFields, complexFields } = simpleMode

    return (
      <div className="space-y-3">
        {visibleSimple.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {visibleSimple.map((key) => (
              <SimpleFieldItem key={key} fieldKey={key} value={data[key]} />
            ))}
          </div>
        )}

        {visibleComplex.length > 0 && (
          <div className="space-y-2">
            {visibleComplex.map((key) => (
              <ComplexFieldItem key={key} fieldKey={key} value={data[key]} />
            ))}
          </div>
        )}

        {enableShowMore && hasMore && !showAll && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll(true)}
            className="text-body text-muted-foreground"
          >
            ... {simpleFields.length + complexFields.length - showTopN} more
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
        )}
      </div>
    )
  }

  // 渲染智能 Diff 模式
  if (!diffMode) return null

  const {
    commonFieldsDiff,
    typeSpecificOld,
    typeSpecificNew,
    oldValues,
    newValues,
    commonFields,
    oldSpecificFields,
    newSpecificFields,
    changedCount,
    unchangedCount,
  } = diffMode

  return (
    <div className="space-y-3">
      {/* 过滤按钮 */}
      {commonFieldsDiff.size > 0 && (
        <div className="flex items-center gap-2 pb-3 border-b border-border/30">
          {changedCount > 0 && (
            <Button
              variant={showOnlyChanges ? 'default' : 'outline'}
              size="sm"
              className={cn('h-7 text-body', showOnlyChanges && 'bg-warning hover:bg-warning')}
              onClick={() => setShowOnlyChanges(!showOnlyChanges)}
            >
              <GitCompare className="mr-1.5 h-3 w-3" />
              {showOnlyChanges
                ? `显示全部 (${commonFieldsDiff.size})`
                : `仅看变化 (${changedCount})`}
            </Button>
          )}
          {(typeSpecificOld.length > 0 || typeSpecificNew.length > 0) && (
            <Button
              variant={showOnlyCommon ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-body"
              onClick={() => setShowOnlyCommon(!showOnlyCommon)}
            >
              仅公共字段 ({commonFieldsDiff.size})
            </Button>
          )}
          {changedCount > 0 && !showOnlyChanges && (
            <div className="ml-auto flex items-center gap-2 text-body text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-warning" />
                {changedCount} 个变化
              </span>
            </div>
          )}
        </div>
      )}

      {/* 公共字段 */}
      {commonFields.all.length > 0 && (
        <div className="space-y-2">
          <div className="text-caption font-semibold text-muted-foreground flex items-center gap-2">
            📊 公共字段 ({commonFieldsDiff.size})
            {changedCount > 0 && <span className="text-warning">~{changedCount}</span>}
            {unchangedCount > 0 && (
              <span className="text-muted-foreground/60">={unchangedCount}</span>
            )}
          </div>

          {/* 简单字段 */}
          {commonFields.simple.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {commonFields.simple.map((key) => (
                <SimpleFieldItem
                  key={key}
                  fieldKey={key}
                  value={data[key]}
                  diff={commonFieldsDiff.get(key)}
                />
              ))}
            </div>
          )}

          {/* 复杂字段 */}
          {commonFields.complex.length > 0 && (
            <div className="space-y-2">
              {commonFields.complex.map((key) => (
                <ComplexFieldItem
                  key={key}
                  fieldKey={key}
                  value={data[key]}
                  diff={commonFieldsDiff.get(key)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 上游特有字段 */}
      {!showOnlyCommon && typeSpecificOld.length > 0 && (
        <CollapsibleSection
          title={`🔼 上游特有 (${typeSpecificOld.length})`}
          count={typeSpecificOld.length}
          defaultExpanded={false}
        >
          <div className="space-y-2">
            {oldSpecificFields.simple.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {oldSpecificFields.simple.map((key) => (
                  <SimpleFieldItem
                    key={key}
                    fieldKey={key}
                    value={oldValues[key]}
                    diff={{ type: 'deleted', oldValue: oldValues[key] }}
                  />
                ))}
              </div>
            )}

            {oldSpecificFields.complex.length > 0 && (
              <div className="space-y-2">
                {oldSpecificFields.complex.map((key) => (
                  <ComplexFieldItem
                    key={key}
                    fieldKey={key}
                    value={oldValues[key]}
                    diff={{ type: 'deleted', oldValue: oldValues[key] }}
                  />
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* 当前特有字段 */}
      {!showOnlyCommon && typeSpecificNew.length > 0 && (
        <CollapsibleSection
          title={`🔽 当前特有 (${typeSpecificNew.length})`}
          count={typeSpecificNew.length}
          defaultExpanded={false}
        >
          <div className="space-y-2">
            {newSpecificFields.simple.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {newSpecificFields.simple.map((key) => (
                  <SimpleFieldItem
                    key={key}
                    fieldKey={key}
                    value={newValues[key]}
                    diff={{ type: 'added', newValue: newValues[key] }}
                  />
                ))}
              </div>
            )}

            {newSpecificFields.complex.length > 0 && (
              <div className="space-y-2">
                {newSpecificFields.complex.map((key) => (
                  <ComplexFieldItem
                    key={key}
                    fieldKey={key}
                    value={newValues[key]}
                    diff={{ type: 'added', newValue: newValues[key] }}
                  />
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}
    </div>
  )
}
