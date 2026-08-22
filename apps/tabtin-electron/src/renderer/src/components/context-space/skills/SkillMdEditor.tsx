import React, { useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button, ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useSkillContentQuery } from '@/hooks/queries/skills'
import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { parseSkillMd } from './skillMdUtils'
import { SkillEditorDialog } from './SkillEditorDialog'
import { isSkillOwnedByCurrentUser } from './skillProductState'

const SkillMarkdownLazy = React.lazy(
  () => import('@components/shared/file-preview/MarkdownViewer').then(m => ({ default: m.MarkdownViewer }))
)

interface SkillMdEditorProps {
  skill: SkillIndexEntry
  spaceId: string
  /** Space 所属 Organization，写本地 SKILL.md 必传——避免落到 `_unscoped` 而 Registry 扫不到。 */
  organizationId: string | null
  currentUserId: string
  /** false = Installed 等浏览态详情，owner 也只读（与内置 Skill 一致） */
  allowOwnerEdit?: boolean
  className?: string
  fillRemaining?: boolean
  onSaved?: () => void
  hideEntryButton?: boolean
  editorOpen?: boolean
  onEditorOpenChange?: (open: boolean) => void
  editableOverride?: boolean
}

/**
 * SkillMdEditor —— 详情页的 SKILL.md 区：只读预览正文，可选打开多文件模态的入口。
 *
 * - `hideEntryButton`：详情页不展示「编辑 / 查看文件」入口（Skill 页当前默认）。
 * - 可编辑来源 →「编辑」：打开可写 `SkillEditorDialog`。
 * - 其它来源 →「查看文件」：打开只读 `SkillEditorDialog`。
 *
 * 编辑/查看都走同一个 `SkillEditorDialog`（Monaco 全屏模态），只是 `readOnly` 决定能力。
 */
export const SkillMdEditor: React.FC<SkillMdEditorProps> = ({
  skill,
  spaceId,
  organizationId,
  currentUserId,
  allowOwnerEdit = true,
  className,
  fillRemaining = false,
  onSaved,
  hideEntryButton = false,
  editorOpen,
  onEditorOpenChange,
  editableOverride,
}) => {
  const { t } = useTranslation('context')
  const skillKey = skill.skill_key || null
  const readsPublishedPackage = skill.visibility === 'organization'
    || skill.visibility === 'public'
    || skill.distribution === 'marketplace'
  const { data: content, isLoading, isError, refetch } = useSkillContentQuery(skillKey, {
    spaceId,
    organizationId,
    sourceDocPath: skill.doc_path ?? null,
    // 组织精选 / 公开市场必须展示发布快照。尤其是尚未获取的市场包，本机还没有
    // SKILL.md；若仍走 LocalSkillRegistry，详情会被误判为空。
    publishedSnapshotSkillId: readsPublishedPackage ? skill.skill_id : null,
  })

  const isOwner = isSkillOwnedByCurrentUser(skill, currentUserId)
  const isUserSkill = normalizeSkillSource(skill.source) === 'user'
  // owner 在自己的 user skill 上永远能编辑——保存写本地文件；version 变化时同步当前版本。
  const editable = editableOverride ?? (
    allowOwnerEdit && isOwner && isUserSkill && Boolean(skillKey) && Boolean(organizationId)
  )

  const [internalEditorOpen, setInternalEditorOpen] = useState(false)
  const showEditor = editorOpen ?? internalEditorOpen
  const setShowEditor = onEditorOpenChange ?? setInternalEditorOpen

  // 预览只渲染正文 body（frontmatter 是元数据，关键字段在详情头部已结构化呈现）。
  const previewBody = useMemo(() => (content ? parseSkillMd(content).body : ''), [content])

  if (!skillKey) return null

  return (
    <div className={cn(fillRemaining ? 'flex min-h-0 flex-1 flex-col gap-2' : 'space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={cn(SETTINGS_GROUP_LABEL, 'flex items-center gap-1.5 mb-0')}>
          <FileText className="h-3 w-3" />
          {t('skills.detail.title')}
        </h3>
        {!hideEntryButton ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-7', 'px-2', CANVAS_TEXT_META)}
            onClick={() => setShowEditor(true)}
          >
            {t(editable ? 'skills.editor.edit' : 'skills.editor.viewFiles')}
          </Button>
        ) : null}
      </div>

      <div className={cn(
        'overflow-hidden rounded-md border border-border/20 bg-muted/10',
        fillRemaining && 'min-h-0 flex-1',
      )}>
        {isLoading ? (
          <div className="space-y-2 p-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-3 animate-pulse rounded bg-muted/40" style={{ width: `${80 - i * 15}%` }} />
            ))}
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 p-3">
            <p className={cn('text-destructive/80', CANVAS_TEXT_META_BASE)}>{t('skills.detail.readError')}</p>
            <button type="button" onClick={() => void refetch()} className={cn('text-accent', 'hover:text-accent/80', 'transition-colors', CANVAS_TEXT_META_BASE)}>
              {t('skills.panel.retry')}
            </button>
          </div>
        ) : !previewBody.trim() ? (
          <div className="space-y-2 p-3">
            <p className={CANVAS_TEXT_META}>{t('skills.detail.empty')}</p>
            {editable && !hideEntryButton ? (
              <Button variant="outline" size="sm" onClick={() => setShowEditor(true)}>
                {t('skills.editor.startEditing')}
              </Button>
            ) : null}
          </div>
        ) : (
          <ScrollArea className={fillRemaining ? 'h-full' : 'max-h-80'}>
            <React.Suspense fallback={
              <div className="space-y-2 p-3">
                {[1, 2].map(i => <div key={i} className="h-3 animate-pulse rounded bg-muted/40" />)}
              </div>
            }>
              <SkillMarkdownLazy
                content={previewBody}
                filePath={skillKey ?? undefined}
                className="!h-auto"
              />
            </React.Suspense>
          </ScrollArea>
        )}
      </div>

      {/* 同一个模态两种模式：可编辑来源可写，其它来源只读。skillKey 已在顶部守卫非空。 */}
      <SkillEditorDialog
        open={showEditor}
        onOpenChange={setShowEditor}
        skill={skill}
        spaceId={spaceId}
        organizationId={organizationId}
        readOnly={!editable}
        onSaved={onSaved}
      />
    </div>
  )
}
