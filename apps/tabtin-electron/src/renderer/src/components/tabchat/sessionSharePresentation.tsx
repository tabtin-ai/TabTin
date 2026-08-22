/**
 * sessionSharePresentation — 共享任务权限档展示口径。
 * 共享卡保留查看 / Fork / 协作三档权限；新建共享入口只展示查看、协作与任务交接。
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import { ChevronDown, Eye, GitBranchPlus, GitFork, MessageSquare } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'

/** 新版共享卡开放协作发言；保留单一开关供共享查看器复用。 */
export const SESSION_SHARE_CAN_CHAT_ENABLED = true

export type ShareTierLevel = 'view' | 'fork' | 'control'
export type SessionShareMode = ShareTierLevel | 'continue'

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string

const TIER_ICON: Record<ShareTierLevel, LucideIcon> = {
  view: Eye,
  fork: GitFork,
  control: MessageSquare,
}

export function resolveShareTierLevel(canFork: boolean, canChat: boolean): ShareTierLevel {
  if (canChat) return 'control'
  if (canFork) return 'fork'
  return 'view'
}

export interface ShareTierPresentation {
  level: ShareTierLevel
  title: string
  description: string
}

export function getShareTierPresentation(
  canFork: boolean,
  canChat: boolean,
  t: TranslateFn,
): ShareTierPresentation {
  const level = resolveShareTierLevel(canFork, canChat)
  const titles: Record<ShareTierLevel, string> = {
    view: t('shareTier.viewTitle', { defaultValue: '实时查看' }),
    fork: t('shareTier.forkTitle', { defaultValue: '查看并抄走' }),
    control: t('shareTier.controlTitle', { defaultValue: '实时协作' }),
  }
  const descriptions: Record<ShareTierLevel, string> = {
    view: t('shareTier.viewDesc', {
      defaultValue: '跟进任务进展，不能操作你的现场。',
    }),
    fork: t('shareTier.forkDesc', {
      defaultValue: '可实时查看，并复制成自己的任务继续推进。',
    }),
    control: t('shareTier.controlDesc', {
      defaultValue: '可在你的任务里发言驱动 Agent；执行、审批与费用仍在你这边。',
    }),
  }
  return {
    level,
    title: titles[level],
    description: descriptions[level],
  }
}

/** 新建 v2 卡与改权限时可选的档位。 */
const SELECTABLE_SHARE_TIERS: Array<{
  value: ShareTierLevel
  canFork: boolean
  canChat: boolean
}> = [
  { value: 'view', canFork: false, canChat: false },
  { value: 'fork', canFork: true, canChat: false },
  { value: 'control', canFork: false, canChat: true },
]

/**
 * 权限档归一化入口；保留独立 Fork 档。
 */
export function clampToSelectableShareTier(level: ShareTierLevel): ShareTierLevel {
  return level
}

export function buildShareTierOptions(t: TranslateFn): Array<{
  value: ShareTierLevel
  title: string
  description: string
}> {
  return SELECTABLE_SHARE_TIERS.map(({ value, canFork, canChat }) => {
    const presentation = getShareTierPresentation(canFork, canChat, t)
    return { value, title: presentation.title, description: presentation.description }
  })
}

interface ShareTierBadgeProps {
  canFork: boolean
  canChat: boolean
  t: TranslateFn
  className?: string
  iconClassName?: string
}

/** 单行权限徽标：hover 显示档位说明 */
export const ShareTierBadge: React.FC<ShareTierBadgeProps> = ({
  canFork,
  canChat,
  t,
  className,
  iconClassName = 'h-3 w-3',
}) => {
  const tier = getShareTierPresentation(canFork, canChat, t)
  const Icon = TIER_ICON[tier.level]

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-md bg-muted/40 px-1.5 py-0.5 text-caption text-muted-foreground',
              className,
            )}
          >
            <Icon className={cn(iconClassName, 'shrink-0')} aria-hidden />
            <span className="truncate">{tier.title}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-[260px] text-body">
          {tier.description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function shareTierToFlags(tier: ShareTierLevel): { canFork: boolean; canChat: boolean } {
  const level = clampToSelectableShareTier(tier)
  return {
    canFork: level === 'fork',
    canChat: SESSION_SHARE_CAN_CHAT_ENABLED && level === 'control',
  }
}

interface ShareSelectOption<T extends string> {
  value: T
  icon: React.ReactNode
  title: string
  description: string
}

export type ShareTierSelectOption = ShareSelectOption<ShareTierLevel>

export function buildShareTierSelectOptions(t: TranslateFn): ShareTierSelectOption[] {
  return buildShareTierOptions(t).map((option) => ({
    ...option,
    icon: shareTierOptionIcon(option.value),
  }))
}

interface ShareSelectProps<T extends string> {
  value: T
  disabled?: boolean
  options: ShareSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}

function ShareSelect<T extends string>({
  value,
  disabled = false,
  options,
  onChange,
  ariaLabel,
  className,
}: ShareSelectProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value) ?? options[0]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={!open ? current.description : undefined}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-interactive bg-muted/30 px-3 text-left text-body transition-colors',
            'hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            disabled && 'cursor-not-allowed opacity-50',
            className,
          )}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-interactive bg-accent/10 text-accent">
            {current.icon}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {current.title}
          </span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
        <TooltipProvider delayDuration={300}>
          <div role="listbox" aria-label={ariaLabel} className="flex flex-col gap-0.5">
            {options.map((option) => (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === option.value}
                    disabled={disabled}
                    onClick={() => {
                      onChange(option.value)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-interactive px-2.5 py-2 text-left transition-colors',
                      value === option.value
                        ? 'bg-foreground/[0.05] text-foreground dark:bg-foreground/[0.08]'
                        : 'text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-interactive',
                        value === option.value
                          ? 'bg-accent/10 text-accent'
                          : 'bg-muted/40 text-muted-foreground',
                      )}
                    >
                      {option.icon}
                    </span>
                    <span className="truncate text-body">{option.title}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" align="center" className="max-w-[260px] text-body">
                  {option.description}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  )
}

interface ShareTierSelectProps {
  value: ShareTierLevel
  disabled?: boolean
  options: ShareTierSelectOption[]
  onChange: (value: ShareTierLevel) => void
  ariaLabel: string
  className?: string
}

/** 共享权限档下拉，供已有权限编辑场景复用。 */
export const ShareTierSelect: React.FC<ShareTierSelectProps> = ({
  value,
  disabled = false,
  options,
  onChange,
  ariaLabel,
  className,
}) => (
  <ShareSelect
    value={clampToSelectableShareTier(value)}
    disabled={disabled}
    options={options}
    onChange={(next) => onChange(clampToSelectableShareTier(next))}
    ariaLabel={ariaLabel}
    className={className}
  />
)

export function buildSessionShareModeOptions(t: TranslateFn): ShareSelectOption<SessionShareMode>[] {
  const shareTierOptions = buildShareTierSelectOptions(t)
  return [
    ...shareTierOptions.filter((option) => option.value !== 'fork'),
    {
      value: 'continue',
      icon: <GitBranchPlus className="h-3.5 w-3.5" aria-hidden />,
      title: t('shareSession.intentContinue', { defaultValue: '交给同事继续' }),
      description: t('shareSession.intentContinueHint', {
        defaultValue: '冻结上下文，创建对方自己的任务',
      }),
    },
  ]
}

interface SessionShareModeFieldProps {
  value: SessionShareMode
  disabled?: boolean
  onChange: (value: SessionShareMode) => void
}

/** 两个共享入口共用的协作方式视图。 */
export const SessionShareModeField: React.FC<SessionShareModeFieldProps> = ({
  value,
  disabled = false,
  onChange,
}) => {
  const { t } = useTranslation('chat')
  const options = useMemo(() => buildSessionShareModeOptions(t), [t])
  const label = t('shareSession.tierLabel', { defaultValue: '协作方式' })

  return (
    <section className="space-y-2">
      <span className="block text-body font-medium text-foreground">{label}</span>
      <ShareSelect
        value={value}
        disabled={disabled}
        options={options}
        onChange={onChange}
        ariaLabel={label}
      />
    </section>
  )
}

export function useShareTierSelectOptions(t: TranslateFn): ShareTierSelectOption[] {
  return useMemo(() => buildShareTierSelectOptions(t), [t])
}

export function shareTierOptionIcon(level: ShareTierLevel, className = 'h-3.5 w-3.5'): React.ReactNode {
  const Icon = TIER_ICON[level]
  return <Icon className={className} aria-hidden />
}
