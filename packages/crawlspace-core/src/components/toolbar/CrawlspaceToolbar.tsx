/**
 * Crawlspace Toolbar
 *
 * 统一的工具栏组件，提供：
 * - URL 地址栏
 * - 前进/后退/刷新按钮
 * - 加载状态显示
 * - 插件自定义按钮区
 * - 下载管理入口
 */

import React, { useState, useCallback, KeyboardEvent, useEffect, useRef, useMemo } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Home,
  X,
  Loader2,
  Lock,
  Unlock,
  Download,
  PackageSearch,
  Puzzle,
  MoreHorizontal,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@tabtin/smartsheet-ui'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import { smartNavigate, isValidUrl as defaultIsValidUrl, isBlankLikeUrl } from '../../utils/helpers'
import { shouldOverflowToolbarActions } from './toolbarActionsOverflow'
import {
  ToolbarOverflowCloseContext,
  type ToolbarOverflowRun,
} from './toolbarOverflowCloseContext'
import { ToolbarActionTooltip } from './ToolbarActionTooltip'

/**
 * 计算 hex 颜色的感知亮度 (W3C relative luminance)
 * @returns 0 (纯黑) ~ 1 (纯白)
 */
function luminance(hex: string): number {
  const m = hex.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (!m) return 0.5
  const toLinear = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * toLinear(parseInt(m[1], 16)) + 0.7152 * toLinear(parseInt(m[2], 16)) + 0.0722 * toLinear(parseInt(m[3], 16))
}

/**
 * 派生一组"基于网页 themeColor"的工具栏颜色 token。
 * 展开态的外壳、地址栏、按钮、输入框共用这套 token，
 * 避免任何一处散布新的阈值，便于后续统一调优。
 */
export interface ToolbarThemeTokens {
  themeColor: string
  isDark: boolean
  foreground: string
  foregroundMuted: string
  foregroundFaint: string
  hoverBg: string
  addressBarBg: string
  addressBarBgHover: string
  addressBarBgFocus: string
  addressBarBorder: string
  addressBarBorderFocus: string
  spinner: string
  progress: string
  pillActiveBg: string
  pillActiveFg: string
}

function deriveThemeTokens(themeColor: string | undefined): ToolbarThemeTokens | null {
  if (!themeColor) return null
  const isDark = luminance(themeColor) < 0.5
  if (isDark) {
    return {
      themeColor,
      isDark: true,
      foreground: 'rgba(255,255,255,0.88)',
      foregroundMuted: 'rgba(255,255,255,0.62)',
      foregroundFaint: 'rgba(255,255,255,0.38)',
      hoverBg: 'rgba(255,255,255,0.15)',
      addressBarBg: 'rgba(255,255,255,0.08)',
      addressBarBgHover: 'rgba(255,255,255,0.12)',
      addressBarBgFocus: 'rgba(255,255,255,0.18)',
      addressBarBorder: 'rgba(255,255,255,0.14)',
      addressBarBorderFocus: 'rgba(255,255,255,0.35)',
      spinner: 'rgba(255,255,255,0.85)',
      progress: 'rgba(255,255,255,0.7)',
      pillActiveBg: 'rgba(255,255,255,0.22)',
      pillActiveFg: 'rgba(255,255,255,0.95)',
    }
  }
  return {
    themeColor,
    isDark: false,
    foreground: 'rgba(0,0,0,0.78)',
    foregroundMuted: 'rgba(0,0,0,0.52)',
    foregroundFaint: 'rgba(0,0,0,0.32)',
    hoverBg: 'rgba(0,0,0,0.08)',
    addressBarBg: 'rgba(0,0,0,0.05)',
    addressBarBgHover: 'rgba(0,0,0,0.08)',
    addressBarBgFocus: 'rgba(255,255,255,0.55)',
    addressBarBorder: 'rgba(0,0,0,0.1)',
    addressBarBorderFocus: 'rgba(0,0,0,0.28)',
    spinner: 'rgba(0,0,0,0.78)',
    progress: 'rgba(0,0,0,0.7)',
    pillActiveBg: 'rgba(0,0,0,0.12)',
    pillActiveFg: 'rgba(0,0,0,0.88)',
  }
}

export interface CrawlspaceToolbarProps {
  /**
   * 导航事件回调
   * @param url - 用户输入的 URL
   */
  onNavigate?: (url: string) => void | Promise<void>

  /**
   * 后退按钮点击
   */
  onBack?: () => void | Promise<void>

  /**
   * 前进按钮点击
   */
  onForward?: () => void | Promise<void>

  /**
   * 刷新按钮点击
   */
  onRefresh?: () => void | Promise<void>

  /**
   * 主页按钮点击（在刷新按钮右侧；打开主页新页签）
   */
  onHome?: () => void | Promise<void>

  /**
   * 停止加载按钮点击
   */
  onStop?: () => void | Promise<void>

  /**
   * 是否可以后退
   */
  canGoBack?: boolean

  /**
   * 是否可以前进
   */
  canGoForward?: boolean

  /**
   * 是否正在加载
   */
  isLoading?: boolean

  /**
   * 是否显示 SSL 安全锁
   */
  isSecure?: boolean

  /**
   * 当前 URL（显示在地址栏）
   */
  currentUrl?: string

  /**
   * 插件自定义操作按钮区（宽态外露）
   */
  actions?: React.ReactNode

  /**
   * 窄态 `...` 菜单下半段（缩放 / 注释等）；宽态不渲染
   */
  actionsMenu?: React.ReactNode

  /**
   * 覆盖测得的工具栏宽度（px）。传入则跳过 ResizeObserver，供单测锁定宽/窄态。
   */
  actionsLayoutWidthPx?: number

  /**
   * 宿主浏览器页是否前台可见。失活时强制关闭 `...` 菜单，避免 trigger 隐藏后浮层锚到 (0,0)。
   */
  hostActive?: boolean

  /**
   * 地址栏占位符
   */
  placeholder?: string

  /**
   * URL 验证函数
   */
  isValidUrl?: (url: string) => boolean

  /**
   * URL 自动补全函数
   */
  autocompleteUrl?: (url: string) => string

  /**
   * 是否禁用
   */
  disabled?: boolean

  /**
   * 页面主题色 (HTML meta theme-color)
   */
  themeColor?: string

  /**
   * 布局发生变化的回调（例如展开/收起导致高度变化）
   */
  onLayoutChange?: () => void

  /**
   * 自定义类名
   */
  className?: string

  /**
   * 活跃下载数量（用于显示 badge）
   */
  downloadCount?: number

  /**
   * 打开下载管理页面
   */
  onOpenDownloads?: () => void

  /**
   * 当前页面资源数量（用于显示 badge）
   */
  resourceCount?: number

  /**
   * 资源面板是否已打开（控制按钮高亮）
   */
  resourcePanelOpen?: boolean

  /**
   * 打开/关闭资源面板
   */
  onToggleResources?: () => void

  /**
   * 激活的 Tins 数量（用于显示 badge）
   */
  tinsActiveCount?: number

  /**
   * Tins 面板是否已打开（控制按钮高亮）
   */
  tinsPanelOpen?: boolean

  /**
   * 打开/关闭 Tins 面板
   */
  onToggleTins?: () => void

  /**
   * 地址栏获得/失去焦点回调（用于显示/隐藏建议列表）
   */
  onUrlInputFocus?: () => void
  onUrlInputBlur?: () => void

  /**
   * 地址栏输入变化回调（实时搜索建议）
   */
  onUrlInputChange?: (value: string) => void

  /**
   * 外部提交的地址栏 URL（例如父组件里的建议列表选择）。
   * 用 version 区分连续选择同一个 URL 的提交事件。
   */
  externalCommittedUrl?: string
  externalCommitVersion?: number

  /**
   * 外部请求地址栏释放焦点的版本号（例如浏览器 view 失活、内容区交互）。
   */
  externalBlurVersion?: number
}

const defaultAutocompleteUrl = smartNavigate

// ==================== CC-018: 提取为独立命名组件，避免父组件 re-render 时重建 ====================
interface ToolbarButtonProps {
  size?: 'sm' | 'md'
  tokens?: ToolbarThemeTokens | null
}

function makeThemedButtonHandlers(
  tokens: ToolbarThemeTokens | null | undefined,
  activeBg: string | null,
): Pick<React.DOMAttributes<HTMLButtonElement>, 'onMouseEnter' | 'onMouseLeave'> | undefined {
  if (!tokens) return undefined
  const restoreBg = activeBg ?? ''
  return {
    onMouseEnter: (e) => { (e.currentTarget as HTMLElement).style.backgroundColor = tokens.hoverBg },
    onMouseLeave: (e) => { (e.currentTarget as HTMLElement).style.backgroundColor = restoreBg },
  }
}

interface DownloadButtonProps extends ToolbarButtonProps {
  onOpenDownloads?: () => void
  downloadCount: number
}

const DownloadButton: React.FC<DownloadButtonProps> = React.memo(({
  size = 'sm', tokens, onOpenDownloads, downloadCount
}) => {
  if (!onOpenDownloads) return null
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  const btnSize = size === 'sm' ? 'p-0.5' : 'p-1.5 w-8 h-8'
  const badgeOffset = size === 'sm' ? '-top-1 -right-1' : '-top-0.5 -right-0.5'
  const badgeSize = size === 'sm' ? 'min-w-[12px] h-3 text-caption' : 'min-w-[14px] h-3.5 text-caption'

  const button = (
    <button
      className={cn(
        'relative rounded-md transition-colors flex items-center justify-center',
        btnSize,
        !tokens && (size === 'sm'
          ? 'hover:bg-muted text-muted-foreground/60 hover:text-foreground/70'
          : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
      )}
      style={tokens ? { color: tokens.foreground } : undefined}
      {...(makeThemedButtonHandlers(tokens, null) ?? {})}
      onClick={(e) => {
        e.stopPropagation()
        onOpenDownloads()
      }}
      title={size === 'sm' ? t('toolbar.downloads') : undefined}
      aria-label={t('toolbar.downloads')}
    >
      <Download className={iconSize} />
      {downloadCount > 0 && (
        <span className={cn(
          "absolute px-0.5 flex items-center justify-center font-bold leading-none bg-primary text-primary-foreground rounded-full",
          badgeOffset,
          badgeSize
        )}>
          {downloadCount > 99 ? '99+' : downloadCount}
        </span>
      )}
    </button>
  )

  if (size === 'sm') return button
  return (
    <ToolbarActionTooltip
      label={t('toolbar.downloads')}
      description={t('toolbar.downloadsDescription')}
    >
      {button}
    </ToolbarActionTooltip>
  )
})
DownloadButton.displayName = 'DownloadButton'

interface ResourceButtonProps extends ToolbarButtonProps {
  onToggleResources?: () => void
  resourceCount: number
  resourcePanelOpen: boolean
}

const ResourceButton: React.FC<ResourceButtonProps> = React.memo(({
  size = 'sm', tokens, onToggleResources, resourceCount, resourcePanelOpen
}) => {
  if (!onToggleResources) return null
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  const btnSize = size === 'sm' ? 'p-0.5' : 'p-1.5 w-8 h-8'
  const hasResources = resourceCount > 0
  // toolbar 上不再显示任何视觉角标/指示器——保持工具栏整体清爽。
  // aria-label 仍带数量（读屏用户可知具体值），用户想看详情就点击展开 panel。
  const resourceLabel = hasResources ? `${t('toolbar.resources')} (${resourceCount > 99 ? '99+' : resourceCount})` : t('toolbar.resources')

  const themedStyle: React.CSSProperties | undefined = tokens
    ? resourcePanelOpen
      ? { color: tokens.pillActiveFg, backgroundColor: tokens.pillActiveBg }
      : { color: tokens.foreground }
    : undefined
  const themedHandlers = tokens && !resourcePanelOpen
    ? makeThemedButtonHandlers(tokens, null)
    : undefined

  const button = (
    <button
      className={cn(
        'rounded-md transition-colors flex items-center justify-center',
        btnSize,
        !tokens && (size === 'sm'
          ? resourcePanelOpen
            ? 'bg-primary/15 text-primary'
            : 'hover:bg-muted text-muted-foreground/60 hover:text-foreground/70'
          : resourcePanelOpen
            ? 'text-primary bg-primary/10 hover:bg-primary/15'
            : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
      )}
      style={themedStyle}
      {...(themedHandlers ?? {})}
      onClick={(e) => {
        e.stopPropagation()
        onToggleResources()
      }}
      title={size === 'sm' ? t('toolbar.resources') : undefined}
      aria-label={resourceLabel}
    >
      <PackageSearch className={iconSize} />
    </button>
  )

  if (size === 'sm') return button
  return (
    <ToolbarActionTooltip
      label={t('toolbar.resources')}
      description={t('toolbar.resourcesDescription')}
    >
      {button}
    </ToolbarActionTooltip>
  )
})
ResourceButton.displayName = 'ResourceButton'

interface TinsButtonProps extends ToolbarButtonProps {
  onToggleTins?: () => void
  tinsActiveCount: number
  tinsPanelOpen: boolean
}

const TinsButton: React.FC<TinsButtonProps> = React.memo(({
  size = 'sm', tokens, onToggleTins, tinsActiveCount, tinsPanelOpen
}) => {
  if (!onToggleTins) return null
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  const btnSize = size === 'sm' ? 'p-0.5' : 'p-1.5 w-8 h-8'

  const themedStyle: React.CSSProperties | undefined = tokens
    ? tinsPanelOpen
      ? { color: tokens.pillActiveFg, backgroundColor: tokens.pillActiveBg }
      : { color: tokens.foreground }
    : undefined
  const themedHandlers = tokens && !tinsPanelOpen
    ? makeThemedButtonHandlers(tokens, null)
    : undefined

  // toolbar 上不再显示活跃指示器（与 ResourceButton 一致，保持视觉清爽）；
  // tinsActiveCount 仍保留在 prop 接口上，aria-label 在有活跃 tin 时带数量。
  const tinsLabel = tinsActiveCount > 0
    ? `${t('toolbar.tins')} (${tinsActiveCount > 99 ? '99+' : tinsActiveCount})`
    : t('toolbar.tins')

  return (
    <button
      className={cn(
        'rounded-md transition-colors flex items-center justify-center',
        btnSize,
        !tokens && (size === 'sm'
          ? tinsPanelOpen
            ? 'bg-primary/15 text-primary'
            : 'hover:bg-muted text-muted-foreground/60 hover:text-foreground/70'
          : tinsPanelOpen
            ? 'text-primary bg-primary/10 hover:bg-primary/15'
            : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
      )}
      style={themedStyle}
      {...(themedHandlers ?? {})}
      onClick={(e) => {
        e.stopPropagation()
        onToggleTins()
      }}
      title={t('toolbar.tins')}
      aria-label={tinsLabel}
    >
      <Puzzle className={iconSize} />
    </button>
  )
})
TinsButton.displayName = 'TinsButton'

const overflowMenuItemClass =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body text-foreground/80 transition-colors hover:bg-muted/30'

interface OverflowMenuItemProps {
  icon: React.ReactNode
  label: string
  active?: boolean
  onSelect: () => void
}

const OverflowMenuItem: React.FC<OverflowMenuItemProps> = ({
  icon,
  label,
  active = false,
  onSelect,
}) => (
  <button
    type="button"
    role="button"
    className={cn(
      overflowMenuItemClass,
      active && 'bg-accent/10 text-foreground',
    )}
    onClick={onSelect}
  >
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
  </button>
)

/**
 * CrawlspaceToolbar 组件
 */
export const CrawlspaceToolbar: React.FC<CrawlspaceToolbarProps> = ({
  onNavigate,
  onBack,
  onForward,
  onRefresh,
  onHome,
  onStop,
  canGoBack = false,
  canGoForward = false,
  isLoading = false,
  isSecure = false,
  currentUrl = '',
  actions,
  actionsMenu,
  actionsLayoutWidthPx,
  hostActive = true,
  placeholder = t('toolbar.placeholder'),
  isValidUrl = defaultIsValidUrl,
  autocompleteUrl = defaultAutocompleteUrl,
  disabled = false,
  themeColor,
  onLayoutChange,
  className,
  downloadCount = 0,
  onOpenDownloads,
  resourceCount = 0,
  resourcePanelOpen = false,
  onToggleResources,
  tinsActiveCount = 0,
  tinsPanelOpen = false,
  onToggleTins,
  onUrlInputFocus,
  onUrlInputBlur,
  onUrlInputChange,
  externalCommittedUrl,
  externalCommitVersion,
  externalBlurVersion,
}) => {
  const tokens = useMemo(() => deriveThemeTokens(themeColor), [themeColor])
  const fgColor = tokens?.foreground

  const [inputValue, setInputValue] = useState(currentUrl)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [isNavigating, setIsNavigating] = useState(false)
  // 默认保持完整工具栏；不因点击页面、滚轮或鼠标离开自动收成紧凑条
  const [isExpanded, setIsExpanded] = useState(true)
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevExpandedRef = useRef(isExpanded)
  const isEditingRef = useRef(false)

  useEffect(() => {
    if (actionsLayoutWidthPx != null) {
      setMeasuredWidth(null)
      return
    }
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const apply = () => {
      setMeasuredWidth(el.getBoundingClientRect().width)
    }
    apply()
    const observer = new ResizeObserver(() => apply())
    observer.observe(el)
    return () => observer.disconnect()
  }, [actionsLayoutWidthPx, isExpanded])

  // jsdom / 尚未 layout 时 getBoundingClientRect 可能为 0，视为未测到（保持宽态）
  const layoutWidth =
    actionsLayoutWidthPx ??
    (measuredWidth != null && measuredWidth > 0 ? measuredWidth : Number.POSITIVE_INFINITY)
  const overflowActions = shouldOverflowToolbarActions(layoutWidth)

  useEffect(() => {
    if (!overflowActions && overflowOpen) {
      setOverflowOpen(false)
    }
  }, [overflowActions, overflowOpen])

  useEffect(() => {
    if (!hostActive && overflowOpen) {
      setOverflowOpen(false)
    }
  }, [hostActive, overflowOpen])

  /** 先同步卸掉菜单；defer 时双 rAF 后再跑业务（切 tab / 截图）。 */
  const runOverflowAction = useCallback<ToolbarOverflowRun>((action, options) => {
    flushSync(() => {
      setOverflowOpen(false)
    })
    if (!action) return
    if (!options?.defer) {
      action()
      return
    }
    if (typeof requestAnimationFrame === 'undefined') {
      queueMicrotask(action)
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        action()
      })
    })
  }, [])

  // BrowserView 是原生 view，点击网页不会让 React input 自然 blur。
  // 因此不能用 activeElement 判断是否同步 URL，只在用户实际改过输入时保护草稿。
  useEffect(() => {
    if (!isEditingRef.current) {
      const input = inputRef.current
      setInputValue(currentUrl)
      if (input && !isBlankLikeUrl(currentUrl) && document.activeElement === input) {
        input.blur()
      }
    }
  }, [currentUrl])

  useEffect(() => {
    if (externalCommittedUrl === undefined) return
    isEditingRef.current = false
    setUrlError(null)
    setInputValue(externalCommittedUrl)
    inputRef.current?.blur()
  }, [externalCommittedUrl, externalCommitVersion])

  useEffect(() => {
    if (!externalBlurVersion) return
    isEditingRef.current = false
    const input = inputRef.current
    if (input && document.activeElement === input) {
      input.blur()
    } else {
      onUrlInputBlur?.()
    }
  }, [externalBlurVersion, onUrlInputBlur])

  // 仅在「用户从紧凑条展开」或「空白新标签需输入 URL」时主动 focus。
  // 完整工具栏常开时，不在 mount / 切窗 / slot 变更时抢焦点（此前监听 crawl-view-slot-change 会在切窗回焦时误触发）。
  useEffect(() => {
    if (!isExpanded) {
      prevExpandedRef.current = false
      return
    }

    const expandedFromCompact = !prevExpandedRef.current
    prevExpandedRef.current = true
    const shouldAutoFocus =
      expandedFromCompact || (currentUrl !== '' && isBlankLikeUrl(currentUrl) && !isLoading)
    if (!shouldAutoFocus) return

    let cancelled = false

    const tryFocus = (): boolean => {
      const el = inputRef.current
      if (!el) return false
      el.focus()
      if (document.activeElement === el) {
        el.select()
        return true
      }
      return false
    }

    if (tryFocus()) return

    let attempts = 0
    const maxAttempts = 30
    const timer = setInterval(() => {
      if (cancelled) {
        clearInterval(timer)
        return
      }
      attempts++
      if (tryFocus() || attempts >= maxAttempts) {
        clearInterval(timer)
      }
    }, 100)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isExpanded, currentUrl, isLoading])

  /**
   * 处理 URL 输入变化
   */
  const handleInputChange = useCallback((value: string) => {
    isEditingRef.current = true
    setInputValue(value)
    setUrlError(null)
    onUrlInputChange?.(value)
  }, [onUrlInputChange])

  const handleInputFocus = useCallback(() => {
    inputRef.current?.select()
    onUrlInputFocus?.()
  }, [onUrlInputFocus])

  const handleInputBlur = useCallback(() => {
    isEditingRef.current = false
    onUrlInputBlur?.()
  }, [onUrlInputBlur])

  /**
   * 处理导航
   */
  const handleNavigate = useCallback(async () => {
    if (!onNavigate) return

    const trimmed = inputValue.trim()
    if (!trimmed) {
      isEditingRef.current = false
      if (currentUrl) {
        setInputValue(currentUrl)
      }
      return
    }

    // 自动补全
    const completed = autocompleteUrl(trimmed)

    // 验证 URL
    if (!isValidUrl(completed)) {
      setUrlError(t('toolbar.error.invalidUrl'))
      return
    }

    inputRef.current?.blur()

    try {
      isEditingRef.current = false
      setIsNavigating(true)
      setUrlError(null)
      await onNavigate(completed)
      setInputValue(completed) // 更新为补全后的 URL
      // inputRef.current?.blur() // 已前置
      // setIsExpanded(false) // 已前置
    } catch (error) {
      console.error('[CrawlspaceToolbar] navigation failed:', error)
      setUrlError(t('toolbar.error.navigateFailed'))
      // 失败则重新展开让用户修改
      setIsExpanded(true)
    } finally {
      setIsNavigating(false)
    }
  }, [inputValue, onNavigate, isValidUrl, autocompleteUrl, currentUrl])

  /**
   * 处理回车键
   */
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !disabled && !isNavigating) {
      handleNavigate()
    } else if (e.key === 'Escape') {
      isEditingRef.current = false
      setInputValue(currentUrl)
      if (!isBlankLikeUrl(currentUrl)) {
        setIsExpanded(false)
        inputRef.current?.blur()
      }
    }
  }, [disabled, isNavigating, handleNavigate, currentUrl])

  /**
   * 处理后退
   */
  const handleBack = useCallback(async () => {
    if (canGoBack && onBack && !disabled) {
      await onBack()
    }
  }, [canGoBack, onBack, disabled])

  /**
   * 处理前进
   */
  const handleForward = useCallback(async () => {
    if (canGoForward && onForward && !disabled) {
      await onForward()
    }
  }, [canGoForward, onForward, disabled])

  /**
   * 处理刷新/停止
   */
  const handleRefreshOrStop = useCallback(async () => {
    if (isLoading && onStop) {
      await onStop()
    } else if (!isLoading && onRefresh) {
      await onRefresh()
    }
  }, [isLoading, onStop, onRefresh])

  const isSecureProtocol = inputValue.startsWith('https://') || isSecure

  const displayUrl = currentUrl || placeholder
  const compactActionCount =
    (isLoading ? 1 : 0) +
    Number(Boolean(onToggleTins)) +
    Number(Boolean(onToggleResources)) +
    Number(Boolean(onOpenDownloads))
  const compactSideReservePx =
    compactActionCount > 0
      ? 8 + compactActionCount * 16 + Math.max(0, compactActionCount - 1) * 4
      : 0

  // 工具栏展开/收起时，通知父容器重新计算布局（WebContentsView bounds 更新）
  const isExpandedRef = useRef(isExpanded)
  useEffect(() => {
    if (isExpandedRef.current !== isExpanded) {
      isExpandedRef.current = isExpanded

      // 立即通知父组件布局变化
      onLayoutChange?.()

      // 延迟一帧等 DOM 布局完成后再触发 window resize 作为兜底
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'))
        // 再延迟一点（如 React concurrent mode 可能导致的渲染延迟）
        setTimeout(() => {
          onLayoutChange?.()
          window.dispatchEvent(new Event('resize'))
        }, 50)
      })
    }
  }, [isExpanded, onLayoutChange])

  // ==================== 紧凑模式渲染 ====================
  if (!isExpanded) {
    return (
      <div
        ref={containerRef}
        role="button"
        tabIndex={0}
        aria-label={t('toolbar.expandAddressBar')}
        className={cn(
          "w-full h-7 relative overflow-hidden transition-colors duration-200 cursor-text select-none",
          "hover:brightness-95", // 用 brightness 替代 hover:bg-accent/5，适应所有背景色
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // 无页面主题色时透出宿主主内容表面，和 ContextTabs / BrowserPane 背景保持一体。
          !themeColor && 'bg-transparent',
          className
        )}
        style={{
          backgroundColor: themeColor || undefined,
          color: fgColor
        }}
        onClick={() => {
          if (!disabled) {
            setIsExpanded(true)
          }
        }}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setIsExpanded(true)
          }
        }}
      >
        {/* 左右预留同等操作区宽度，避免窄窗口时域名与按钮重叠 */}
        <div
          className="grid h-full w-full items-center gap-2"
          style={{ gridTemplateColumns: `${compactSideReservePx}px minmax(0, 1fr) ${compactSideReservePx}px` }}
        >
          <div aria-hidden="true" />
          <div className={cn(
            'flex min-w-0 items-center justify-center gap-1.5 px-2 text-body',
            !themeColor && 'text-muted-foreground/80'
          )}>
            {isSecureProtocol && <Lock className="w-3 h-3 flex-shrink-0 opacity-70" />}
            <span className="truncate font-medium tracking-tight" title={displayUrl}>
              {displayUrl}
            </span>
          </div>

          {/* 紧凑模式右侧操作区 */}
          <div className="z-sticky flex items-center justify-end gap-1 pr-2">
            {isLoading && (
              <Loader2
                className={cn("w-3 h-3 animate-spin", !themeColor && "text-primary/70")}
                style={themeColor ? { color: fgColor } : undefined}
              />
            )}
            <TinsButton size="sm" tokens={tokens} onToggleTins={onToggleTins} tinsActiveCount={tinsActiveCount} tinsPanelOpen={tinsPanelOpen} />
            <ResourceButton size="sm" tokens={tokens} onToggleResources={onToggleResources} resourceCount={resourceCount} resourcePanelOpen={resourcePanelOpen} />
            <DownloadButton size="sm" tokens={tokens} onOpenDownloads={onOpenDownloads} downloadCount={downloadCount} />
          </div>
        </div>

        {/* 紧凑模式不显示底部进度条，避免视觉上"工具栏高度回弹" */}
      </div>
    )
  }

  // ==================== 展开模式渲染 (完整工具栏) ====================
  const navButtonClass = cn(
    'p-1.5 rounded-md transition-colors w-8 h-8 flex items-center justify-center',
  )
  const navButtonThemedStyle = tokens
    ? (disabledState: boolean): React.CSSProperties => ({
        color: disabledState ? tokens.foregroundFaint : tokens.foreground,
      })
    : undefined
  const navButtonThemedHandlers = tokens ? makeThemedButtonHandlers(tokens, null) : undefined
  const addressBarStyle: React.CSSProperties | undefined = tokens
    ? {
        backgroundColor: tokens.addressBarBg,
        borderColor: tokens.addressBarBorder,
        color: tokens.foreground,
        // 用 CSS variable 让 input 的 placeholder 也能吃到主题色
        ['--tb-placeholder-color' as any]: tokens.foregroundFaint,
        ['--tb-focus-ring' as any]: tokens.addressBarBorderFocus,
      }
    : undefined

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex items-center gap-2 px-3 py-2 relative z-sticky',
        // 无页面主题色时透出宿主主内容表面，和 ContextTabs / BrowserPane 背景保持一体。
        !tokens && 'bg-transparent',
        disabled && 'opacity-50 pointer-events-none',
        className
      )}
      style={tokens
        ? {
            backgroundColor: tokens.themeColor,
            color: tokens.foreground,
          }
        : undefined}
    >
      {/* 导航按钮组 */}
      <div className="flex items-center gap-0.5">
        {/* 后退按钮 */}
        <button
          onClick={handleBack}
          disabled={!canGoBack || disabled}
          className={cn(
            navButtonClass,
            !tokens && (!canGoBack || disabled
              ? 'text-muted-foreground/30 cursor-not-allowed'
              : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
            (!canGoBack || disabled) && 'cursor-not-allowed',
          )}
          style={navButtonThemedStyle?.(!canGoBack || disabled)}
          {...(!canGoBack || disabled ? {} : navButtonThemedHandlers ?? {})}
          title={t('toolbar.back')}
          aria-label={t('toolbar.back')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* 前进按钮 */}
        <button
          onClick={handleForward}
          disabled={!canGoForward || disabled}
          className={cn(
            navButtonClass,
            !tokens && (!canGoForward || disabled
              ? 'text-muted-foreground/30 cursor-not-allowed'
              : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
            (!canGoForward || disabled) && 'cursor-not-allowed',
          )}
          style={navButtonThemedStyle?.(!canGoForward || disabled)}
          {...(!canGoForward || disabled ? {} : navButtonThemedHandlers ?? {})}
          title={t('toolbar.forward')}
          aria-label={t('toolbar.forward')}
        >
          <ArrowRight className="w-4 h-4" />
        </button>

        {/* 刷新/停止按钮 */}
        <button
          onClick={handleRefreshOrStop}
          disabled={disabled}
          className={cn(
            navButtonClass,
            !tokens && (disabled
              ? 'text-muted-foreground/30 cursor-not-allowed'
              : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
            disabled && 'cursor-not-allowed',
          )}
          style={navButtonThemedStyle?.(disabled)}
          {...(disabled ? {} : navButtonThemedHandlers ?? {})}
          title={isLoading ? t('toolbar.stop') : t('toolbar.reload')}
          aria-label={isLoading ? t('toolbar.stop') : t('toolbar.reload')}
        >
          {isLoading ? (
            <X className="w-4 h-4" />
          ) : (
            <RotateCw className="w-3.5 h-3.5" />
          )}
        </button>

        {/* 主页按钮：打开主页新页签 */}
        {onHome && (
          <button
            onClick={() => { void onHome() }}
            disabled={disabled}
            className={cn(
              navButtonClass,
              !tokens && (disabled
                ? 'text-muted-foreground/30 cursor-not-allowed'
                : 'text-foreground/70 hover:text-foreground hover:bg-muted'),
              disabled && 'cursor-not-allowed',
            )}
            style={navButtonThemedStyle?.(disabled)}
            {...(disabled ? {} : navButtonThemedHandlers ?? {})}
            title={t('toolbar.home')}
            aria-label={t('toolbar.home')}
          >
            <Home className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 地址栏容器 */}
      <div
        className={cn(
          'flex-1 relative flex items-center border rounded-full transition-all duration-200 h-9',
          !tokens && 'bg-background/60 hover:bg-background/80 focus-within:bg-background',
          !tokens && 'focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring',
          urlError
            ? 'border-destructive/50 bg-destructive/5'
            : !tokens && 'border-border/30 focus-within:border-border',
        )}
        style={
          urlError
            ? undefined
            : addressBarStyle
        }
      >
        {/* 安全锁图标 */}
        <div
          className={cn('pl-3 pr-1.5 flex items-center justify-center', !tokens && 'text-muted-foreground/50')}
          style={tokens ? { color: tokens.foregroundMuted } : undefined}
        >
          {isSecureProtocol ? (
            <Lock className="w-3.5 h-3.5" />
          ) : (
            <Unlock className="w-3.5 h-3.5" />
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isNavigating}
          spellCheck={false}
          autoFocus={currentUrl !== '' && isBlankLikeUrl(currentUrl) && !isLoading}
          autoComplete="off"
          className={cn(
            'flex-1 bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 text-body px-0 w-full min-w-0 [&:focus]:shadow-none',
            !tokens && 'text-foreground placeholder:text-muted-foreground/40',
            tokens && 'placeholder:text-[color:var(--tb-placeholder-color)]',
          )}
          style={
            tokens
              ? { boxShadow: 'none', outline: 'none', color: tokens.foreground }
              : { boxShadow: 'none', outline: 'none' }
          }
        />

        {/* 加载指示器（Spinner） */}
        {(isLoading || isNavigating) && (
          <div className="pr-3 flex items-center justify-center">
            <Loader2
              className={cn('w-3.5 h-3.5 animate-spin', !tokens && 'text-primary')}
              style={tokens ? { color: tokens.spinner } : undefined}
            />
          </div>
        )}

        {/* 底部加载进度条（模拟） */}
        {(isLoading || isNavigating) && (
          <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden rounded-b-full">
            <div
              className={cn('h-full animate-progress-indeterminate origin-left', !tokens && 'bg-primary/80')}
              style={tokens ? { backgroundColor: tokens.progress } : undefined}
            />
          </div>
        )}
      </div>

      {/* Tins + 下载按钮 + 插件自定义操作区（窄态收进 ...） */}
      <div className="flex items-center gap-1 pl-1">
        {overflowActions ? (
          <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                  !tokens && 'text-foreground/70 hover:bg-muted hover:text-foreground',
                )}
                style={tokens ? { color: tokens.foreground } : undefined}
                {...(tokens ? makeThemedButtonHandlers(tokens, null) : {})}
                title={t('toolbar.overflow.title')}
                aria-label={t('toolbar.overflow.open')}
                disabled={disabled}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            {/* 仅 open 时挂载 Content：关掉离场动画，避免 trigger 失活后浮层被重锚到左上角 */}
            {overflowOpen ? (
              <PopoverContent
                side="bottom"
                align="end"
                sideOffset={4}
                className="w-60 p-1"
                // 脱离 Space OverlayContainer：避免切走浏览器后 trigger 失活把浮层锚到左上角
                container={typeof document !== 'undefined' ? document.body : undefined}
                collisionBoundary={null}
              >
                <div
                  data-testid="browser-toolbar-actions-overflow"
                  className="flex flex-col py-0.5"
                >
                  {onToggleResources ? (
                    <OverflowMenuItem
                      icon={<PackageSearch className="h-4 w-4" />}
                      label={
                        resourceCount > 0
                          ? `${t('toolbar.resources')} (${resourceCount > 99 ? '99+' : resourceCount})`
                          : t('toolbar.resources')
                      }
                      active={resourcePanelOpen}
                    onSelect={() => {
                      runOverflowAction(() => {
                        onToggleResources()
                      }, { defer: true })
                    }}
                  />
                ) : null}
                {onOpenDownloads ? (
                  <OverflowMenuItem
                    icon={<Download className="h-4 w-4" />}
                    label={
                      downloadCount > 0
                        ? `${t('toolbar.downloads')} (${downloadCount > 99 ? '99+' : downloadCount})`
                        : t('toolbar.downloads')
                    }
                    onSelect={() => {
                      runOverflowAction(() => {
                        onOpenDownloads()
                      }, { defer: true })
                    }}
                  />
                ) : null}
                {onToggleTins ? (
                  <OverflowMenuItem
                    icon={<Puzzle className="h-4 w-4" />}
                    label={
                      tinsActiveCount > 0
                        ? `${t('toolbar.tins')} (${tinsActiveCount > 99 ? '99+' : tinsActiveCount})`
                        : t('toolbar.tins')
                    }
                    active={tinsPanelOpen}
                    onSelect={() => {
                      runOverflowAction(() => {
                        onToggleTins()
                      }, { defer: true })
                    }}
                  />
                ) : null}
                {actionsMenu ? (
                  <>
                    <div
                      className={cn('my-1 h-px', !tokens && 'bg-border/40')}
                      style={tokens ? { backgroundColor: tokens.addressBarBorder } : undefined}
                      role="separator"
                    />
                    <ToolbarOverflowCloseContext.Provider value={runOverflowAction}>
                      {actionsMenu}
                    </ToolbarOverflowCloseContext.Provider>
                  </>
                ) : null}
              </div>
            </PopoverContent>
            ) : null}
          </Popover>
        ) : (
          <>
            <TinsButton size="md" tokens={tokens} onToggleTins={onToggleTins} tinsActiveCount={tinsActiveCount} tinsPanelOpen={tinsPanelOpen} />
            <ResourceButton size="md" tokens={tokens} onToggleResources={onToggleResources} resourceCount={resourceCount} resourcePanelOpen={resourcePanelOpen} />
            <DownloadButton size="md" tokens={tokens} onOpenDownloads={onOpenDownloads} downloadCount={downloadCount} />
            {actions && (
              <div
                className={cn('flex items-center gap-1 pl-2 ml-1 border-l', !tokens && 'border-border/40')}
                style={tokens ? { borderColor: tokens.addressBarBorder } : undefined}
              >
                {actions}
              </div>
            )}
          </>
        )}
      </div>

      {/* 错误提示浮窗 */}
      {urlError && (
        <div className="absolute top-full left-12 mt-2 px-3 py-1.5 bg-destructive text-destructive-foreground text-body rounded shadow-lg z-modal animate-in fade-in slide-in-from-top-1">
          {urlError}
          <div className="absolute -top-1 left-4 w-2 h-2 bg-destructive rotate-45" />
        </div>
      )}
    </div>
  )
}
