import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { buildChipItems } from './capabilityUtils'
import type { OutcomeState } from './types'

export function StatusPill({
  active,
  label,
  muted = false,
}: {
  active: boolean
  label: string
  muted?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium',
        active
          ? 'bg-success/10 text-success'
          : 'bg-warning/10 text-warning',
        muted && 'opacity-70',
      )}
    >
      {label}
    </span>
  )
}

export function ChipList({
  items,
  emptyText,
  dimmed = false,
}: {
  items: string[]
  emptyText: string
  dimmed?: boolean
}) {
  if (items.length === 0) {
    return <p className="text-body text-muted-foreground/60">{emptyText}</p>
  }

  const { visible, remaining } = buildChipItems(items)

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map(item => (
        <span
          key={item}
          className={cn(
            'inline-flex items-center rounded border border-border/20 bg-muted/25 px-1.5 py-0.5 text-caption font-mono text-muted-foreground/80',
            dimmed && 'opacity-65',
          )}
        >
          {item}
        </span>
      ))}
      {remaining > 0 && (
        <span className="inline-flex items-center rounded border border-border/20 bg-muted/20 px-1.5 py-0.5 text-caption text-muted-foreground/55">
          +{remaining}
        </span>
      )}
    </div>
  )
}

const STATE_LABEL_DEFAULTS: Record<OutcomeState, string> = {
  available: '可直接用',
  fallback: '有后备入口',
  blocked: '当前不可用',
  unknown: '等待判断',
}

export function OutcomeCard({
  icon,
  title,
  state,
  detail,
  helper,
  stateLabel,
}: {
  icon: React.ReactNode
  title: string
  state: OutcomeState
  detail: string
  helper: string
  stateLabel?: string
}) {
  const toneClass = state === 'available'
    ? 'border-success/30 bg-success/5'
    : state === 'fallback'
      ? 'border-warning/30 bg-warning/5'
      : state === 'blocked'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-border/30 bg-muted/10'
  const badgeClass = state === 'available'
    ? 'bg-success/10 text-success'
    : state === 'fallback'
      ? 'bg-warning/10 text-warning'
      : state === 'blocked'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground'
  const resolvedLabel = stateLabel ?? STATE_LABEL_DEFAULTS[state]

  return (
    <div className={cn('rounded-lg border px-3 py-3', toneClass)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/80">{icon}</span>
          <span className="text-body font-medium text-foreground">{title}</span>
        </div>
        <span className={cn('rounded px-1.5 py-0.5 text-caption font-medium', badgeClass)}>
          {resolvedLabel}
        </span>
      </div>
      <p className="mt-2 text-body text-foreground">{detail}</p>
      <p className="mt-1 text-caption leading-relaxed text-muted-foreground/65">{helper}</p>
    </div>
  )
}

export function SummaryStat({
  label,
  value,
  helper,
}: {
  label: string
  value: string
  helper: string
}) {
  return (
    <div className="rounded-lg border border-border/30 bg-muted/15 px-3 py-2.5">
      <div className={SETTINGS_GROUP_LABEL}>
        {label}
      </div>
      <div className="mt-1 text-title font-semibold text-foreground">
        {value}
      </div>
      <div className="mt-1 text-caption leading-relaxed text-muted-foreground/60">
        {helper}
      </div>
    </div>
  )
}

export function MountedCapabilityRow({
  icon,
  label,
  count,
  items,
  emptyText,
  helper,
}: {
  icon: React.ReactNode
  label: string
  count: string
  items: string[]
  emptyText: string
  helper?: string
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border/25 bg-muted/10 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground/60">{icon}</span>
          <span className="text-body font-medium text-foreground">{label}</span>
        </div>
        <span className="rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
          {count}
        </span>
      </div>
      {helper && (
        <p className="text-caption text-muted-foreground/55">
          {helper}
        </p>
      )}
      <ChipList items={items} emptyText={emptyText} />
    </div>
  )
}
