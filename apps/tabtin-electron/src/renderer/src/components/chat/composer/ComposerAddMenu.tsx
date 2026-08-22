import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronRight,
  Paperclip,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react'
import { OVERLAY_SURFACE_CLASS, useOverlayContainer } from '@components/ui'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useScopedEventListener } from '@hooks/spaceActivity'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'
import type { ContextRef } from '../types'
import type {
  SkillSlashCommandOption,
  SlashCommandOption,
} from '../skill/skillSlashCommand'
import { resolveCurrentAgentId } from '../model/resolveAgentDisplayName'
import { COMPOSER_TOOLBAR_BUTTON, COMPOSER_TOOLBAR_ICON_CLASS, COMPOSER_TOOLBAR_ICON_STROKE, COMPOSER_TEXT_META, COMPOSER_TEXT_META_BASE } from '../registry/chatDesignTokens'
import {
  resolveFloatingMenuLayout,
  type FloatingMenuLayout,
} from '../panel/floatingMenuLayout'
import { insertLeadingSkillToken } from './insertLeadingSkillToken'

type ComposerAddView = 'root' | 'skills' | 'mcp'
const MENU_MAX_WIDTH = 280
const MENU_MIN_HEIGHT = 160
const FLYOUT_WIDTH = 260
const FLYOUT_GAP = 4
const FLYOUT_MAX_HEIGHT = 440
const FLYOUT_MIN_HEIGHT = 240
const VIEWPORT_SAFE_GAP = 16
const log = createLogger('ComposerAddMenu')

interface ComposerAddMenuProps {
  disabled?: boolean
  isStreaming?: boolean
  attachmentLimitReached: boolean
  handleFileSelect: () => void
  slashOptions: SlashCommandOption[]
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  sessionId?: string | null
  slashOpen: boolean
  mentionOpen: boolean
  presetPickerOpen: boolean
  contextRefs: ContextRef[]
  onAddContextRef?: (
    type: 'mcp_server',
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => void
  onRemoveContextRef?: (id: string) => void
  closeSkillSlash: () => void
  setMentionOpen: (open: boolean) => void
  setPresetPickerOpen: React.Dispatch<React.SetStateAction<boolean>>
}

// eslint-disable-next-line complexity -- 三个小型菜单视图共享同一状态机，拆成互传闭包反而扩大接口面。
export function ComposerAddMenu({
  disabled,
  isStreaming,
  attachmentLimitReached,
  handleFileSelect,
  slashOptions,
  input,
  setInput,
  textareaRef,
  sessionId,
  slashOpen,
  mentionOpen,
  presetPickerOpen,
  contextRefs,
  onAddContextRef,
  onRemoveContextRef,
  closeSkillSlash,
  setMentionOpen,
  setPresetPickerOpen,
}: ComposerAddMenuProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<ComposerAddView>('root')
  const [search, setSearch] = useState('')
  const [connections, setConnections] = useState<LocalMcpConnectionSummary[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState(false)
  const [mcpRetryToken, setMcpRetryToken] = useState(0)
  const [menuLayout, setMenuLayout] = useState<FloatingMenuLayout>({
    width: MENU_MAX_WIDTH,
    height: MENU_MIN_HEIGHT,
    left: 16,
    placement: 'up',
    bottom: 16,
  })
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const previousAgentIdRef = useRef<string | null | undefined>(undefined)
  const overlayContainer = useOverlayContainer()
  const { isForeground } = useSpaceActivity()
  const openSettings = useSettingsSpaceStore(state => state.openSettings)
  const session = useChatStore(state => sessionId ? state.getSessionById(sessionId) : undefined)
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  // 与斜杠 / 展示名同口径：草稿回落 selectedAgent（技能列表本身来自 slashOptions）
  const currentAgentId = resolveCurrentAgentId({
    sessionAgentId: session?.agent_id,
    selectedAgentId: selectedAgent?.id,
  })

  const close = () => {
    setOpen(false)
    setView('root')
    setSearch('')
  }

  // ：二级浮层不靠 mouseleave 收回（过滤变矮会补发 leave 误关）。
  // 进入 Skill/MCP 行展开；进入附件行或其它一级项切回 root；点外部 / Escape 关闭。
  const openFlyout = (nextView: ComposerAddView) => {
    if (view !== nextView) {
      setView(nextView)
      setSearch('')
    }
  }

  const updateMenuLayout = () => {
    setMenuLayout(resolveFloatingMenuLayout({
      trigger: anchorRef.current,
      maxWidth: MENU_MAX_WIDTH,
      minHeight: MENU_MIN_HEIGHT,
      contentHeight: menuRef.current?.scrollHeight ?? 0,
    }))
  }

  const toggle = () => {
    if (open) {
      close()
      return
    }
    closeSkillSlash()
    setMentionOpen(false)
    setPresetPickerOpen(false)
    updateMenuLayout()
    setOpen(true)
  }

  useEffect(() => {
    if (open && !isForeground) close()
  }, [isForeground, open])

  useEffect(() => {
    if (open && (slashOpen || mentionOpen || presetPickerOpen)) close()
  }, [mentionOpen, open, presetPickerOpen, slashOpen])

  useEffect(() => {
    const previousAgentId = previousAgentIdRef.current
    if (previousAgentId === currentAgentId) return
    previousAgentIdRef.current = currentAgentId
    if (previousAgentId !== undefined && previousAgentId !== null) {
      contextRefs
        .filter(ref => ref.type === 'mcp_server')
        .forEach(ref => onRemoveContextRef?.(ref.id))
    }
    // Agent 是菜单数据作用域；切换后绝不能短暂保留上一 Agent 的 MCP 列表。
    setOpen(false)
    setView('root')
    setSearch('')
    setConnections([])
    setMcpError(false)
  }, [contextRefs, currentAgentId, onRemoveContextRef])

  const documentTarget = typeof document === 'undefined' ? null : document
  useScopedEventListener<MouseEvent>(documentTarget, 'mousedown', (event) => {
    const target = event.target as Node
    if (
      !menuRef.current?.contains(target)
      && !flyoutRef.current?.contains(target)
      && !anchorRef.current?.contains(target)
    ) close()
  }, { enabled: open })
  useScopedEventListener<KeyboardEvent>(documentTarget, 'keydown', (event) => {
    if (event.key !== 'Escape') return
    if (view !== 'root') {
      setView('root')
      setSearch('')
      return
    }
    close()
    requestAnimationFrame(() => anchorRef.current?.focus())
  }, { enabled: open })

  const windowTarget = typeof window === 'undefined' ? null : window
  useScopedEventListener(windowTarget, 'resize', updateMenuLayout, { enabled: open })
  useScopedEventListener(windowTarget, 'scroll', updateMenuLayout, {
    enabled: open,
    capture: true,
  })
  useEffect(() => {
    if (!open) return
    const rafId = requestAnimationFrame(updateMenuLayout)
    return () => cancelAnimationFrame(rafId)
  }, [connections.length, mcpError, mcpLoading, open, search, view])

  useEffect(() => {
    if (!open || view !== 'mcp' || !currentAgentId) return
    let cancelled = false
    setMcpLoading(true)
    setMcpError(false)
    void window.tabtin.localMcp.listConnections()
      .then(items => {
        if (!cancelled) setConnections(items)
      })
      .catch((error) => {
        log.warn('读取当前 Agent 的 MCP 连接失败', { agentId: currentAgentId, error })
        if (!cancelled) {
          setConnections([])
          setMcpError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setMcpLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentAgentId, mcpRetryToken, open, view])

  const skills = useMemo(
    () => slashOptions.filter((option): option is SkillSlashCommandOption => option.kind === 'skill'),
    [slashOptions],
  )
  const visibleSkills = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return skills
    return skills.filter(skill =>
      [skill.label, skill.token, skill.description].join(' ').toLowerCase().includes(query))
  }, [search, skills])
  const visibleMcp = useMemo(() => {
    const query = search.trim().toLowerCase()
    return connections
      .filter(connection =>
        connection.enabled
        && Boolean(currentAgentId && connection.attachedAgentIds.includes(currentAgentId)))
      .filter(connection =>
        !query
        || [connection.name, connection.source.label].join(' ').toLowerCase().includes(query))
  }, [connections, currentAgentId, search])
  const focusedByConnectionId = useMemo(
    () => new Map(
      contextRefs
        .filter(ref => ref.type === 'mcp_server')
        .map(ref => [ref.resourceId, ref]),
    ),
    [contextRefs],
  )

  // 二级浮层贴一级菜单右侧；右侧放不下时翻到左侧（动画滑入方向同步翻转）。
  // 高度不限于一级菜单（一级只有 3 行很矮）：底边对齐一级底边，向上延伸到
  // 视口安全边距，上限 FLYOUT_MAX_HEIGHT。
  const flyoutPlacement = useMemo(() => {
    const rightLeft = menuLayout.left + menuLayout.width + FLYOUT_GAP
    const fitsRight = typeof window === 'undefined'
      || rightLeft + FLYOUT_WIDTH <= window.innerWidth - 8
    let available = FLYOUT_MAX_HEIGHT
    if (typeof window !== 'undefined') {
      const viewport = window.innerHeight
      available = menuLayout.bottom != null
        ? viewport - menuLayout.bottom - VIEWPORT_SAFE_GAP
        : viewport - (menuLayout.top ?? 0) - VIEWPORT_SAFE_GAP
    }
    return {
      side: fitsRight ? 'right' : 'left',
      left: fitsRight ? rightLeft : Math.max(8, menuLayout.left - FLYOUT_WIDTH - FLYOUT_GAP),
      maxHeight: Math.max(FLYOUT_MIN_HEIGHT, Math.min(FLYOUT_MAX_HEIGHT, available)),
    } as const
  }, [menuLayout])

  const handleArrowNav = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [
      ...Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ...Array.from(flyoutRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = current < 0
      ? (delta > 0 ? 0 : buttons.length - 1)
      : (current + delta + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }

  const chooseSkill = (skill: SkillSlashCommandOption) => {
    const next = insertLeadingSkillToken(input, skill, slashOptions)
    setInput(next.value)
    close()
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(next.cursor, next.cursor)
    })
  }

  const toggleMcp = (connection: LocalMcpConnectionSummary) => {
    const focused = focusedByConnectionId.get(connection.id)
    if (focused) {
      onRemoveContextRef?.(focused.id)
      return
    }
    onAddContextRef?.('mcp_server', connection.id, connection.name, {
      meta: {
        serverName: connection.name,
        sourceLabel: connection.source.label,
        preview: connection.name,
      },
    })
  }

  const menu = open ? (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('input.addMenu', { defaultValue: '添加附件、Skill 或 MCP' })}
      onKeyDown={handleArrowNav}
      className={cn(
        OVERLAY_SURFACE_CLASS,
        'fixed z-dropdown overflow-hidden rounded-xl border border-border/40 p-1 shadow-xl',
        'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150',
      )}
      style={{
        top: menuLayout.top,
        bottom: menuLayout.bottom,
        left: menuLayout.left,
        width: menuLayout.width,
        maxHeight: menuLayout.height,
      }}
    >
      <div className="space-y-0.5">
        <MenuRow
          icon={Paperclip}
          label={t('input.addMenuAttachment', { defaultValue: '添加附件' })}
          disabled={Boolean(disabled || isStreaming)}
          title={attachmentLimitReached
            ? t('input.imageLimitReached', { defaultValue: '最多添加10张图片' })
            : undefined}
          onMouseEnter={() => openFlyout('root')}
          onClick={() => {
            close()
            handleFileSelect()
          }}
        />
        <MenuRow
          icon={Sparkles}
          label={t('input.addMenuSkill', { defaultValue: 'Skill' })}
          title={skills.length === 0
            ? t('input.addMenuNoSkills', { defaultValue: '暂无可用 Skill' })
            : undefined}
          disabled={Boolean(disabled || skills.length === 0)}
          highlighted={view === 'skills'}
          trailing={<ChevronRight className="h-3.5 w-3.5" />}
          onMouseEnter={() => {
            if (skills.length > 0) openFlyout('skills')
          }}
          onClick={() => openFlyout('skills')}
        />
        <MenuRow
          icon={Plug}
          label={t('input.addMenuMcp', { defaultValue: 'MCP' })}
          title={!currentAgentId
            ? t('input.addMenuChooseAgent', { defaultValue: '请先选择 Agent' })
            : undefined}
          disabled={Boolean(disabled || !currentAgentId || !onAddContextRef)}
          highlighted={view === 'mcp'}
          trailing={<ChevronRight className="h-3.5 w-3.5" />}
          onMouseEnter={() => {
            if (currentAgentId && onAddContextRef) openFlyout('mcp')
          }}
          onClick={() => openFlyout('mcp')}
        />
      </div>
    </div>
  ) : null

  const flyout = open && view !== 'root' ? (
    <div
      ref={flyoutRef}
      role="menu"
      aria-label={view === 'skills'
        ? t('input.addMenuChooseSkill', { defaultValue: '选择 Skill' })
        : t('input.addMenuChooseMcp', { defaultValue: '选择 MCP focus' })}
      onKeyDown={handleArrowNav}
      className={cn(
        OVERLAY_SURFACE_CLASS,
        'fixed z-dropdown flex flex-col overflow-hidden rounded-xl border border-border/40 p-1 shadow-xl',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        flyoutPlacement.side === 'right' ? 'slide-in-from-left-1' : 'slide-in-from-right-1',
      )}
      style={{
        top: menuLayout.top,
        bottom: menuLayout.bottom,
        left: flyoutPlacement.left,
        width: FLYOUT_WIDTH,
        maxHeight: flyoutPlacement.maxHeight,
      }}
    >
      <div className={cn('px-2.5 py-1.5 font-medium', COMPOSER_TEXT_META)}>
        {view === 'skills'
          ? t('input.addMenuChooseSkill', { defaultValue: '选择 Skill' })
          : t('input.addMenuChooseMcp', { defaultValue: '选择 MCP focus' })}
      </div>
      <div className="relative m-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          className="h-8 w-full rounded-md border border-border/40 bg-background/60 pl-8 pr-2 text-body outline-none focus:border-accent/60"
          placeholder={t('input.addMenuSearch', { defaultValue: '搜索' })}
          aria-label={t('input.addMenuSearch', { defaultValue: '搜索' })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-0.5">
        {view === 'skills' ? (
          visibleSkills.length > 0
            ? visibleSkills.map(skill => (
                <MenuRow
                  key={skill.canonicalKey}
                  icon={Sparkles}
                  label={skill.label}
                  description={skill.token}
                  onClick={() => chooseSkill(skill)}
                />
              ))
            : <MenuEmpty text={t('input.addMenuNoSkillMatches', { defaultValue: '没有匹配的 Skill' })} />
        ) : mcpLoading ? (
          <MenuEmpty text={t('input.addMenuMcpLoading', { defaultValue: '正在读取 MCP…' })} />
        ) : mcpError ? (
          <div className="p-2">
            <MenuEmpty text={t('input.addMenuMcpLoadFailed', { defaultValue: 'MCP 连接读取失败' })} />
            <button
              type="button"
              className={cn('mt-1 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-accent hover:bg-muted/30', COMPOSER_TEXT_META_BASE)}
              onClick={() => setMcpRetryToken(value => value + 1)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('input.addMenuRetry', { defaultValue: '重试' })}
            </button>
          </div>
        ) : visibleMcp.length > 0 ? (
          visibleMcp.map(connection => {
            const selected = focusedByConnectionId.has(connection.id)
            return (
              <MenuRow
                key={connection.id}
                icon={Plug}
                label={connection.name}
                description={connection.source.label}
                trailing={selected ? <Check className="h-4 w-4 text-accent" /> : null}
                onClick={() => toggleMcp(connection)}
              />
            )
          })
        ) : (
          <div className="p-2">
            <MenuEmpty text={t('input.addMenuMcpEmpty', { defaultValue: '当前 Agent 暂无已启用的 MCP' })} />
            <button
              type="button"
              className={cn('mt-1 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-accent hover:bg-muted/30', COMPOSER_TEXT_META_BASE)}
              onClick={() => {
                close()
                openSettings({ category: 'device', section: 'advancedConnections' })
              }}
            >
              <Settings className="h-3.5 w-3.5" />
              {t('input.addMenuManageMcp', { defaultValue: '管理 MCP' })}
            </button>
          </div>
        )}
      </div>
    </div>
  ) : null

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={cn(
          COMPOSER_TOOLBAR_BUTTON,
          open && 'bg-foreground/[0.06] text-accent-text',
          disabled && 'cursor-not-allowed opacity-40',
        )}
        aria-label={t('input.addMenu', { defaultValue: '添加附件、Skill 或 MCP' })}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Plus className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
      </button>
      {menu || flyout ? createPortal(<>{menu}{flyout}</>, overlayContainer ?? document.body) : null}
    </>
  )
}

function MenuRow({
  icon: Icon,
  label,
  description,
  disabled,
  highlighted,
  trailing,
  title,
  onClick,
  onMouseEnter,
}: {
  icon: React.FC<{ className?: string; strokeWidth?: number }>
  label: string
  description?: string
  disabled?: boolean
  highlighted?: boolean
  trailing?: React.ReactNode
  title?: string
  onClick: () => void
  onMouseEnter?: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-40',
        highlighted && 'bg-muted/35',
      )}
    >
      <Icon className={cn(COMPOSER_TOOLBAR_ICON_CLASS, 'text-muted-foreground')} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-foreground">{label}</span>
        {description ? (
          <span className={cn('block truncate', COMPOSER_TEXT_META)}>{description}</span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0 text-muted-foreground">{trailing}</span> : null}
    </button>
  )
}

function MenuEmpty({ text }: { text: string }) {
  return <div className={cn('px-3 py-5 text-center', COMPOSER_TEXT_META)}>{text}</div>
}
