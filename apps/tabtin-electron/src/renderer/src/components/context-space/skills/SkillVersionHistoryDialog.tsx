import React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, History } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  ScrollArea,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO } from '@components/layout/canvasUi'
import type { SkillIndexEntry, SkillVersion } from '@/skills/types'
import { ContextDialogHeader } from '../ContextDialogHeader'
import {
  useActivateSkillVersionMutation,
  useSkillVersionsListQuery,
} from '@/hooks/queries/skills'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { formatSkillVersionLabel } from './skillSemver'

/**
 * 版本历史弹窗 —— 列出已发布版本，并支持把某一版「设为当前版本」（本 Space 激活）。
 * 不提供「回滚到此版本」（Package Registry revert）：与「设为当前」对用户易混淆，
 * 且会影响组织内最新指针；需要回滚时走重新发布旧内容即可。
 * 本组件独占版本相关 hooks；SkillPanel 只挂载它，详情页保持轻量。
 */
interface SkillVersionHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: SkillIndexEntry
  spaceId: string
  isOwner: boolean
}

function formatPublishedAt(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

const ReviewStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const { t } = useTranslation('context')
  const normalized = (status || '').trim()
  // 仅审核中 / 已驳回需要醒目；已发布 / 已通过不另外占用空间。
  if (normalized === 'pending_review') {
    return (
      <span className={cn('inline-flex', 'items-center', 'rounded', 'bg-amber-500/10', 'px-1.5', 'py-0.5', 'text-amber-600', 'dark:text-amber-400', CANVAS_TEXT_MICRO)}>
        {t('skills.versionHistory.reviewStatus.pending_review')}
      </span>
    )
  }
  if (normalized === 'rejected') {
    return (
      <span className={cn('inline-flex', 'items-center', 'rounded', 'bg-destructive/10', 'px-1.5', 'py-0.5', 'text-destructive', CANVAS_TEXT_META_BASE)}>
        {t('skills.versionHistory.reviewStatus.rejected')}
      </span>
    )
  }
  return null
}

export const SkillVersionHistoryDialog: React.FC<SkillVersionHistoryDialogProps> = ({
  open,
  onOpenChange,
  skill,
  spaceId,
  isOwner,
}) => {
  const { t } = useTranslation('context')
  const skillId = skill.skill_id || null
  // ：activate 走 organization_id + agent_id 锚点；spaceId 仅本地 IPC 落盘用。
  const organizationId = useSpaceStore(state =>
    state.spaces.find(s => s.id === spaceId)?.organization_id ?? '',
  )
  const selectedAgentId = useSpaceStore(state => state.selectedAgent?.id ?? '')
  const { data: versions = [], isLoading } = useSkillVersionsListQuery(open ? skillId : null)
  const activateMutation = useActivateSkillVersionMutation()

  // 「当前」= 本 Space 实际安装的版本；没装过则回退最新发布版本。
  const currentSeq = skill.installed_version_seq ?? skill.latest_version_seq ?? null
  const busy = activateMutation.isPending

  const handleActivate = async (v: SkillVersion) => {
    try {
      await activateMutation.mutateAsync({
        skillId: skill.skill_id,
        skill,
        spaceId,
        organization_id: organizationId,
        agent_id: selectedAgentId,
        version_seq: v.version_seq,
      })
      toast({
        title: t('skills.versionHistory.activated', {
          version: formatSkillVersionLabel(v.version_label) || v.version_label || String(v.version_seq),
        }),
      })
    } catch (err) {
      toast({
        title: t('skills.versionHistory.activateFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<History className="h-7 w-7" />}
          title={t('skills.versionHistory.title')}
          description={<span className="font-mono">{skill.display_name || skill.name}</span>}
        />

        <ScrollArea className="max-h-[60vh]">
          {isLoading ? (
            <div className="py-8 text-center text-body text-muted-foreground/60">
              {t('skills.versionHistory.loading')}
            </div>
          ) : versions.length === 0 ? (
            <div className="py-8 text-center text-body text-muted-foreground/60">
              {t('skills.versionHistory.empty')}
            </div>
          ) : (
            <ul className="space-y-2 pr-2">
              {versions.map(v => {
                const isCurrent = currentSeq != null && v.version_seq === currentSeq
                const label = formatSkillVersionLabel(v.version_label)
                  || (v.version_label || '').trim()
                  || null
                const changeNote = v.change_note?.trim()
                if (!label) return null
                return (
                  <li key={v.version_seq} className="rounded-lg border bg-muted/20 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="font-mono text-body font-medium">{label}</span>
                        {isCurrent && (
                          <span className={cn('inline-flex', 'items-center', 'rounded', 'bg-primary/10', 'px-1.5', 'py-0.5', 'text-primary', CANVAS_TEXT_META_BASE)}>
                            {t('skills.versionHistory.current')}
                          </span>
                        )}
                        <ReviewStatusBadge status={v.review_status} />
                      </div>
                      {formatPublishedAt(v.published_at) && (
                        <span className={cn('shrink-0', CANVAS_TEXT_META)}>
                          {formatPublishedAt(v.published_at)}
                        </span>
                      )}
                    </div>
                    <p className={cn('mt-1', CANVAS_TEXT_META)}>
                      {changeNote || t('skills.versionHistory.noChangeNote')}
                    </p>
                    {isOwner && !isCurrent && (
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn('h-7', 'gap-1', CANVAS_TEXT_META)}
                          disabled={busy}
                          onClick={() => handleActivate(v)}
                        >
                          <Check className="h-3 w-3" />
                          {activateMutation.isPending
                            ? t('skills.versionHistory.activating')
                            : t('skills.versionHistory.activate')}
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

SkillVersionHistoryDialog.displayName = 'SkillVersionHistoryDialog'
