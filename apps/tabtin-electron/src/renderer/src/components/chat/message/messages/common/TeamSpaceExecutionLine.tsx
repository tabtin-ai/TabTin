import React from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'

type TeamSpaceExecutionDisplay = {
  initiator: string
  executionOwner: string
  executionSpace: string
}

function shortId(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  return value.length > 8 ? value.slice(0, 8) : value
}

function stringFromRecord(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function extractTeamSpaceExecutionDisplay(
  metadata?: Record<string, unknown> | null,
): TeamSpaceExecutionDisplay | null {
  const raw = metadata?.team_space_execution
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const meta = raw as Record<string, unknown>
  const initiator = stringFromRecord(meta, 'initiator_display_name')
    || shortId(meta.initiator_user_id)
  const executionOwner = stringFromRecord(meta, 'execution_owner_display_name')
    || shortId(meta.execution_owner_user_id)
  const executionSpace = stringFromRecord(meta, 'execution_space_name')
    || shortId(meta.execution_space_id)
  if (!initiator && !executionOwner && !executionSpace) return null
  return { initiator, executionOwner, executionSpace }
}

export const TeamSpaceExecutionLine: React.FC<{
  metadata?: Record<string, unknown> | null
  align?: 'left' | 'right'
}> = ({ metadata, align = 'left' }) => {
  const { t } = useTranslation('chat')
  const display = extractTeamSpaceExecutionDisplay(metadata)
  if (!display) return null
  return (
    <div
      className={cn(
        'mt-1 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground/55',
        align === 'right' ? 'justify-end' : 'justify-start',
      )}
      data-testid="team-space-execution-meta"
    >
      {display.initiator && (
        <span>
          {t('teamSpaceExecution.initiatedBy', { defaultValue: '发起' })}
          {' '}
          {display.initiator}
        </span>
      )}
      {(display.executionOwner || display.executionSpace) && (
        <span className="min-w-0">
          {t('teamSpaceExecution.executedBy', { defaultValue: '执行' })}
          {' '}
          {[display.executionOwner, display.executionSpace].filter(Boolean).join(' / ')}
        </span>
      )}
    </div>
  )
}
