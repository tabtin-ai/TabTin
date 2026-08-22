import React from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, Check, ChevronDown, ChevronUp, Loader2, Search, X, Zap } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ScrollArea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  useOverlayContainer,
} from '@tabtin/smartsheet-ui'
import type { ToolbarField } from '../../types'
import type { DataGridSearchScope } from '../grid/DataGridContext'
import {
  GRID_SEARCH_INPUT_ATTR,
  GRID_SEARCH_INPUT_VALUE,
  GRID_SEARCH_REQUEST_EVENT,
  type GridSearchRequestDetail,
} from '../../utils/gridSearchFocus'

const SEARCH_INDEX_SUGGEST_THRESHOLD = 5000
/** 工具栏搜索防抖：本地匹配 / 服务端请求都经此闸，避免每键卡顿 */
const SEARCH_DEBOUNCE_MS = 300

function SearchTooltip({
  content,
  children,
}: {
  content: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export interface GridToolbarSearchButtonProps {
  value: string
  fields: ToolbarField[]
  placeholder: string
  activateLabel: string
  scope: DataGridSearchScope
  selectedFieldIds: string[]
  hideNotMatchRows: boolean
  scopeAllFieldsLabel: string
  scopeCurrentFieldLabel: string
  selectedFieldsCountLabel: string
  selectFieldsTitle: string
  showAllRowsLabel: string
  hideNotMatchRowsLabel: string
  navigatePrevLabel: string
  navigateNextLabel: string
  closeSearchLabel: string
  searchIndexTitle: string
  searchIndexCheckingLabel: string
  searchIndexEnableLabel: string
  searchIndexDisableLabel: string
  searchIndexRepairLabel: string
  searchIndexRepairHintLabel: string
  searchIndexUnsupportedLabel: string
  searchIndexStatusEnabledLabel: string
  searchIndexStatusDisabledLabel: string
  searchIndexSupported: boolean
  searchIndexEnabled: boolean
  searchIndexAbnormalCount: number
  searchIndexLoading: boolean
  searchIndexActionLoading: boolean
  currentFieldLabel?: string | null
  matchCount: number
  currentMatchIndex: number
  searchLimitReached?: boolean
  searchLimitWarning?: string
  totalRowsCount?: number
  searchIndexSuggestionLabel?: string
  searchIndexSuggestionEnableLabel?: string
  searchIndexSuggestionDismissLabel?: string
  onSearch: (query: string) => void
  onScopeChange: (scope: DataGridSearchScope) => void
  onSelectedFieldIdsChange: (fieldIds: string[]) => void
  onHideNotMatchRowsChange: (value: boolean) => void
  onSearchIndexToggle?: (enabled: boolean) => void
  onSearchIndexRepair?: () => void
  onNavigateNext?: () => void
  onNavigatePrev?: () => void
  onActiveChange?: (active: boolean) => void
  searchTargetId?: string
  className?: string
}

/**
 * 判断当前是否应由「本表格视图」接管 Cmd+F。Cmd+F 监听挂在 window 上，
 * 多张表格分屏 / 与侧边栏聊天框同屏时会互相串扰，故按焦点归属裁决：
 * - 焦点落在本视图（[data-t-grid-view]）内 → 接管
 * - 页面无明确焦点（body）且仅有一张表格视图 → 接管（保持单表场景 Cmd+F 直接可用）
 * - 焦点在别处（聊天框 / 其它面板 / 另一张分屏表格），或多表且无焦点（歧义） → 不接管
 */
const shouldHandleSearchHotkey = (viewRoot: HTMLElement | null): boolean => {
  // 无 OverlayContainer（Provider 之外的降级场景）时退回旧行为，避免破坏既有功能
  if (!viewRoot || typeof document === 'undefined') return true
  const active = document.activeElement
  if (active && viewRoot.contains(active)) return true
  if (!active || active === document.body) {
    return document.querySelectorAll('[data-t-grid-view]').length <= 1
  }
  return false
}

export const GridToolbarSearchButton: React.FC<GridToolbarSearchButtonProps> = ({
  value,
  fields,
  placeholder,
  activateLabel,
  scope,
  selectedFieldIds,
  hideNotMatchRows,
  scopeAllFieldsLabel,
  scopeCurrentFieldLabel,
  selectedFieldsCountLabel,
  selectFieldsTitle,
  showAllRowsLabel,
  hideNotMatchRowsLabel,
  navigatePrevLabel,
  navigateNextLabel,
  closeSearchLabel,
  searchIndexTitle,
  searchIndexCheckingLabel,
  searchIndexEnableLabel,
  searchIndexDisableLabel,
  searchIndexRepairLabel,
  searchIndexRepairHintLabel,
  searchIndexUnsupportedLabel,
  searchIndexStatusEnabledLabel,
  searchIndexStatusDisabledLabel,
  searchIndexSupported,
  searchIndexEnabled,
  searchIndexAbnormalCount,
  searchIndexLoading,
  searchIndexActionLoading,
  currentFieldLabel,
  matchCount,
  currentMatchIndex,
  searchLimitReached,
  searchLimitWarning,
  onSearch,
  onScopeChange,
  onSelectedFieldIdsChange,
  onHideNotMatchRowsChange,
  onSearchIndexToggle,
  onSearchIndexRepair,
  totalRowsCount,
  searchIndexSuggestionLabel,
  searchIndexSuggestionEnableLabel,
  searchIndexSuggestionDismissLabel,
  onNavigateNext,
  onNavigatePrev,
  onActiveChange,
  searchTargetId,
  className,
}) => {
  const [active, setActive] = React.useState(Boolean(value))
  const [inputValue, setInputValue] = React.useState(value)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [suggestionDismissed, setSuggestionDismissed] = React.useState(false)
  const isComposingRef = React.useRef(false)
  // 本搜索框所属的表格视图根（[data-t-grid-view]），用于把 Cmd+F 限定在「当前聚焦的这张表」
  const viewRoot = useOverlayContainer()

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
  const shortcutHint = `${isMac ? '⌘' : 'Ctrl'}+F`

  React.useEffect(() => {
    onActiveChange?.(active)
  }, [active, onActiveChange])

  const hasMatches = matchCount > 0
  const hasSearchIndexAbnormal = searchIndexSupported && searchIndexEnabled && searchIndexAbnormalCount > 0
  const currentDisplayIndex = hasMatches ? currentMatchIndex + 1 : 0

  const showSuggestion =
    !suggestionDismissed &&
    searchIndexSupported &&
    !searchIndexEnabled &&
    !searchIndexLoading &&
    typeof totalRowsCount === 'number' &&
    totalRowsCount >= SEARCH_INDEX_SUGGEST_THRESHOLD

  const normalizedSelectedFieldIds = React.useMemo(
    () => selectedFieldIds.filter(fieldId => fields.some(field => field.id === fieldId)),
    [fields, selectedFieldIds]
  )

  const ensureAtLeastOneSearchField = React.useCallback(() => {
    if (normalizedSelectedFieldIds.length > 0 || fields.length === 0) return
    onSelectedFieldIdsChange([fields[0].id])
  }, [fields, normalizedSelectedFieldIds.length, onSelectedFieldIdsChange])

  React.useEffect(() => {
    if (scope === 'current_field') ensureAtLeastOneSearchField()
  }, [ensureAtLeastOneSearchField, scope])

  const selectedFieldNames = React.useMemo(
    () =>
      normalizedSelectedFieldIds
        .map(fieldId => fields.find(field => field.id === fieldId)?.name)
        .filter((name): name is string => Boolean(name)),
    [fields, normalizedSelectedFieldIds]
  )

  const scopeLabel = React.useMemo(() => {
    if (scope === 'all_fields') return scopeAllFieldsLabel
    if (selectedFieldNames.length === 1) return selectedFieldNames[0]
    if (selectedFieldNames.length > 1) {
      if (selectedFieldsCountLabel.includes('{{count}}')) {
        return selectedFieldsCountLabel.replace('{{count}}', String(selectedFieldNames.length))
      }
      return `${selectedFieldsCountLabel} (${selectedFieldNames.length})`
    }
    return currentFieldLabel || scopeCurrentFieldLabel
  }, [currentFieldLabel, scope, scopeAllFieldsLabel, scopeCurrentFieldLabel, selectedFieldNames, selectedFieldsCountLabel])

  const searchIndexStatusLabel = searchIndexEnabled
    ? searchIndexStatusEnabledLabel
    : searchIndexStatusDisabledLabel

  const searchIndexRepairDisplayLabel = React.useMemo(() => {
    if (!searchIndexRepairLabel.includes('{{count}}')) {
      return `${searchIndexRepairLabel} (${searchIndexAbnormalCount})`
    }
    return searchIndexRepairLabel.replace('{{count}}', String(searchIndexAbnormalCount))
  }, [searchIndexAbnormalCount, searchIndexRepairLabel])

  React.useEffect(() => {
    if (isComposingRef.current) return
    setInputValue(value)
    if (value && !active) setActive(true)
  }, [active, value])

  React.useEffect(() => {
    if (!active || isComposingRef.current) return
    // 清空立即生效；有内容则防抖，避免大表每键同步跑本地匹配
    if (!inputValue.trim()) {
      onSearch('')
      return
    }
    const timer = window.setTimeout(() => {
      if (isComposingRef.current) return
      onSearch(inputValue)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [active, inputValue, onSearch])

  React.useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => {
      if (document.activeElement === inputRef.current) return
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [active])

  React.useEffect(() => {
    if (!searchTargetId) return
    const handleSearchRequest = (event: Event) => {
      const detail = (event as CustomEvent<GridSearchRequestDetail>).detail
      if (detail?.tableId !== searchTargetId) return
      setActive(true)
    }
    window.addEventListener(GRID_SEARCH_REQUEST_EVENT, handleSearchRequest)
    return () => window.removeEventListener(GRID_SEARCH_REQUEST_EVENT, handleSearchRequest)
  }, [searchTargetId])

  const closeAndClear = React.useCallback(() => {
    setActive(false)
    if (inputValue) {
      setInputValue('')
      onSearch('')
    }
  }, [inputValue, onSearch])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modPressed = isMac ? event.metaKey : event.ctrlKey
      if (modPressed && event.key.toLowerCase() === 'f') {
        // 仅在「焦点落在本表格视图内」时接管 Cmd+F；否则不抢键，避免劫持
        // 侧边栏聊天框、其它面板或另一张分屏表格的查找。
        if (!shouldHandleSearchHotkey(viewRoot)) return
        event.preventDefault()
        setActive(true)
        return
      }
      if (event.key === 'Escape' && active) closeAndClear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, closeAndClear, isMac, viewRoot])

  const handleNavigateNext = React.useCallback(() => {
    if (!hasMatches) return
    onNavigateNext?.()
  }, [hasMatches, onNavigateNext])

  const handleNavigatePrev = React.useCallback(() => {
    if (!hasMatches) return
    onNavigatePrev?.()
  }, [hasMatches, onNavigatePrev])

  const activateFromPointer = React.useCallback(() => {
    if (!active) {
      // iOS only opens the software keyboard when focus stays in the original
      // user gesture. Mount the input synchronously before focusing it.
      flushSync(() => setActive(true))
    }
    inputRef.current?.focus()
  }, [active])

  if (!active) {
    return (
      <SearchTooltip content={`${activateLabel} (${shortcutHint})`}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={activateLabel}
          className={cn('h-7 gap-1.5 px-2', className)}
          onClick={activateFromPointer}
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
      </SearchTooltip>
    )
  }

  return (
    <div
      className={cn(
        'flex h-7 w-[380px] min-w-0 max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-1.5',
        className,
      )}
    >
      <Search className="ml-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={scopeLabel}
          >
            {hasSearchIndexAbnormal ? <AlertCircle className="h-3 w-3 text-destructive" /> : null}
            <span className="max-w-[104px] truncate">{scopeLabel}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => onScopeChange('all_fields')}>
            {scopeAllFieldsLabel}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={fields.length === 0}
            onSelect={() => {
              onScopeChange('current_field')
              ensureAtLeastOneSearchField()
            }}
          >
            {scopeCurrentFieldLabel}
          </DropdownMenuItem>

          {scope === 'current_field' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-body text-muted-foreground">
                {selectFieldsTitle}
              </DropdownMenuLabel>
              <ScrollArea className="max-h-44">
                {fields.map(field => {
                  const checked = normalizedSelectedFieldIds.includes(field.id)
                  return (
                    <DropdownMenuCheckboxItem
                      key={field.id}
                      checked={checked}
                      onSelect={event => event.preventDefault()}
                      onCheckedChange={nextChecked => {
                        const shouldCheck = nextChecked === true
                        if (shouldCheck) {
                          if (!checked) onSelectedFieldIdsChange([...normalizedSelectedFieldIds, field.id])
                          return
                        }
                        if (!checked || normalizedSelectedFieldIds.length <= 1) return
                        onSelectedFieldIdsChange(normalizedSelectedFieldIds.filter(fid => fid !== field.id))
                      }}
                    >
                      <span className="truncate" title={field.name}>{field.name}</span>
                    </DropdownMenuCheckboxItem>
                  )
                })}
              </ScrollArea>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onHideNotMatchRowsChange(false)}>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {hideNotMatchRows ? <span className="h-3 w-3 shrink-0" /> : <Check className="h-3 w-3 shrink-0 text-primary" />}
              <span className="truncate">{showAllRowsLabel}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onHideNotMatchRowsChange(true)}>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {hideNotMatchRows ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <span className="h-3 w-3 shrink-0" />}
              <span className="truncate">{hideNotMatchRowsLabel}</span>
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-body text-muted-foreground">{searchIndexTitle}</DropdownMenuLabel>

          {searchIndexLoading ? (
            <DropdownMenuItem disabled>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                <span className="truncate">{searchIndexCheckingLabel}</span>
              </span>
            </DropdownMenuItem>
          ) : !searchIndexSupported ? (
            <DropdownMenuItem disabled>
              <span className="truncate text-muted-foreground">{searchIndexUnsupportedLabel}</span>
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                disabled={searchIndexActionLoading}
                onSelect={event => {
                  event.preventDefault()
                  onSearchIndexToggle?.(!searchIndexEnabled)
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {searchIndexEnabled ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <span className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{searchIndexEnabled ? searchIndexDisableLabel : searchIndexEnableLabel}</span>
                </span>
              </DropdownMenuItem>

              <DropdownMenuItem disabled>
                <span className="truncate text-muted-foreground">{searchIndexStatusLabel}</span>
              </DropdownMenuItem>

              {hasSearchIndexAbnormal ? (
                <DropdownMenuItem
                  disabled={searchIndexActionLoading}
                  onSelect={event => {
                    event.preventDefault()
                    onSearchIndexRepair?.()
                  }}
                  title={searchIndexRepairHintLabel}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-destructive">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    <span className="truncate">{searchIndexRepairDisplayLabel}</span>
                    {searchIndexActionLoading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : null}
                  </span>
                </DropdownMenuItem>
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={inputRef}
        {...{ [GRID_SEARCH_INPUT_ATTR]: GRID_SEARCH_INPUT_VALUE }}
        value={inputValue}
        maxLength={1000}
        onChange={event => setInputValue(event.target.value)}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={event => {
          isComposingRef.current = false
          setInputValue((event.target as HTMLInputElement).value)
          onSearch((event.target as HTMLInputElement).value)
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || isComposingRef.current) return
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) handleNavigatePrev()
            else handleNavigateNext()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            closeAndClear()
          }
        }}
        placeholder={placeholder}
        className="h-6 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />

      <div className="flex items-center gap-0.5">
        {searchLimitReached && (
          <SearchTooltip content={searchLimitWarning ?? 'Search limited to first 5000 rows'}>
            <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
          </SearchTooltip>
        )}
        <span className="min-w-[48px] text-right text-caption text-muted-foreground">
          {hasMatches ? `${currentDisplayIndex}/${matchCount}` : '0/0'}
        </span>

        <button
          type="button"
          onClick={handleNavigatePrev}
          disabled={!hasMatches}
          className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={navigatePrevLabel}
        >
          <ChevronUp className="h-3 w-3" />
        </button>

        <button
          type="button"
          onClick={handleNavigateNext}
          disabled={!hasMatches}
          className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={navigateNextLabel}
        >
          <ChevronDown className="h-3 w-3" />
        </button>

        <button
          type="button"
          onClick={closeAndClear}
          className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={closeSearchLabel}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {showSuggestion && (
        <SearchTooltip content={searchIndexSuggestionLabel ?? ''}>
          <div className="ml-0.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onSearchIndexToggle?.(true)
                setSuggestionDismissed(true)
              }}
              disabled={searchIndexActionLoading}
              className="inline-flex h-5 items-center gap-1 rounded-md bg-primary/10 px-1.5 text-caption font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Zap className="h-3 w-3" />
              <span className="whitespace-nowrap">{searchIndexSuggestionEnableLabel ?? 'Enable index'}</span>
            </button>
            <button
              type="button"
              onClick={() => setSuggestionDismissed(true)}
              className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              title={searchIndexSuggestionDismissLabel ?? 'Dismiss'}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        </SearchTooltip>
      )}
    </div>
  )
}
