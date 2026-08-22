import React from 'react'
import { createPortal } from 'react-dom'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import type { SlashCommandOption } from './skillSlashCommand'

interface SkillSlashCommandPopoverProps {
  open: boolean
  query: string
  options: SlashCommandOption[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (option: SlashCommandOption) => void
  anchorEl?: HTMLElement | null
}

const POPOVER_MAX_WIDTH = 360
const VIEWPORT_GUTTER = 8
const ANCHOR_GAP = 8
const FALLBACK_BOTTOM = 96

function sourceLabel(option: SlashCommandOption): string {
  if (option.kind === 'builtin') return '内置'
  const skill = option.skill
  if (typeof skill.meta?.personal_plugin_id === 'string') {
    return typeof skill.meta.personal_plugin_display_name === 'string'
      ? skill.meta.personal_plugin_display_name
      : typeof skill.meta.personal_plugin_name === 'string'
        ? skill.meta.personal_plugin_name
        : skill.meta.personal_plugin_id || 'Plugin'
  }
  if (skill.source === 'platform') return 'Platform'
  if (skill.source === 'app' && skill.distribution === 'marketplace') return 'Marketplace'
  if (skill.source === 'app') return 'App'
  if (skill.source === 'device') return 'Device'
  if (
    skill.source === 'workspace'
    || skill.skill_key?.startsWith('workspace:')
    || skill.meta?.from_workspace_scan === true
  ) {
    return '工作空间'
  }
  return 'User'
}

export const SkillSlashCommandPopover: React.FC<SkillSlashCommandPopoverProps> = ({
  open,
  query,
  options,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  anchorEl,
}) => {
  const { t } = useTranslation('chat')
  const popoverRef = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState<React.CSSProperties>(() => ({
    position: 'fixed',
    left: VIEWPORT_GUTTER,
    bottom: FALLBACK_BOTTOM,
    width: POPOVER_MAX_WIDTH,
  }))

  React.useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const width = Math.max(0, Math.min(POPOVER_MAX_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2))
      const anchorRect = anchorEl?.getBoundingClientRect()
      const popoverHeight = popoverRef.current?.getBoundingClientRect().height ?? 0

      const desiredLeft = anchorRect ? anchorRect.left + VIEWPORT_GUTTER : VIEWPORT_GUTTER
      const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - VIEWPORT_GUTTER - width)
      const left = Math.min(Math.max(desiredLeft, VIEWPORT_GUTTER), maxLeft)

      if (!anchorRect || popoverHeight <= 0) {
        setPosition({
          position: 'fixed',
          left,
          bottom: FALLBACK_BOTTOM,
          width,
        })
        return
      }

      const aboveTop = anchorRect.top - popoverHeight - ANCHOR_GAP
      const belowTop = anchorRect.bottom + ANCHOR_GAP
      const top = aboveTop >= VIEWPORT_GUTTER
        ? aboveTop
        : Math.min(belowTop, Math.max(VIEWPORT_GUTTER, window.innerHeight - VIEWPORT_GUTTER - popoverHeight))

      setPosition({
        position: 'fixed',
        left,
        top,
        width,
      })
    }

    const raf = window.requestAnimationFrame(updatePosition)
    const settleTimer = window.setTimeout(updatePosition, 180)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(settleTimer)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorEl, open, options.length, query])

  React.useEffect(() => {
    if (!open) return
    const activeEl = popoverRef.current?.querySelector('[data-active="true"]') as HTMLElement | null
    if (typeof activeEl?.scrollIntoView !== 'function') return
    activeEl.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, options.length, query])

  if (!open) return null

  return createPortal(
    <div
      ref={popoverRef}
      style={position}
      className={cn(
        'z-dropdown overflow-hidden rounded-interactive',
        OVERLAY_SURFACE_CLASS,
        'animate-in fade-in-0 duration-100',
      )}
      role="listbox"
      aria-label={t('skillSlash.title')}
      data-testid="skill-slash-popover"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-accent" />
        <span className="text-caption font-medium text-foreground">{t('skillSlash.title')}</span>
        <span className="ml-auto text-caption text-muted-foreground/60">{t('skillSlash.hint')}</span>
      </div>

      {options.length === 0 ? (
        <div className="px-3 py-4 text-caption text-muted-foreground/60">
          {query
            ? t('skillSlash.emptySearch', { query })
            : t('skillSlash.empty')}
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto py-1">
          {options.map((option, index) => {
            const active = index === activeIndex
            return (
              <button
                key={option.canonicalKey}
                type="button"
                role="option"
                aria-selected={active}
                aria-label={[option.token, option.label, option.description].filter(Boolean).join(' · ')}
                data-active={active || undefined}
                data-skill-slash-token={option.token}
                className={cn(
                  'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors',
                  active ? 'bg-accent/10 text-foreground' : 'text-foreground hover:bg-muted/40',
                )}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => onSelect(option)}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-caption leading-4 text-foreground">
                    {option.token}
                  </span>
                  <span className="ml-auto shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-caption leading-3 text-muted-foreground/60">
                    {sourceLabel(option)}
                  </span>
                </span>
                {option.description ? (
                  <span className="line-clamp-2 text-caption leading-4 text-muted-foreground/65">
                    {option.description}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </div>,
    document.body,
  )
}
