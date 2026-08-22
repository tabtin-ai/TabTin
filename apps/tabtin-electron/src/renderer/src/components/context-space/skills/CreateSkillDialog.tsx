import React, { useState, useCallback, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogFooter, DialogScrollBody,
  Button, Input, Textarea, toast,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META, CANVAS_TEXT_META_BASE } from '@components/layout/canvasUi'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ContextDialogHeader } from '../ContextDialogHeader'
import { useCreateSkillMutation } from '@/hooks/queries/skills'
import { useSpaceStore } from '@stores/useSpaceStore'
import { joinPath } from '@components/shared/file-utils'
import { generateSkillSkeleton, writeSkillContent } from './skillMdUtils'
import { SKILL_MARKET_CATEGORY_ORDER } from '../capability-marketplace/skillMarketTaxonomy'
import { slugifySkillName, userCanonicalKeyFromSlug, isValidKebabSlug } from './skillSlug'
import { resolveAgentIdForOrganization } from './skillAgentAssignment'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

/**
 * 新建 Skill 的标准目录骨架（除 SKILL.md 外）。Skill 本质是一个目录：
 * `references/` 放给 Agent 相对路径引用 + read_file 自取的素材，`scripts/` 放可执行脚本。
 * 建出空目录让用户一进多文件编辑器就看到结构，知道往哪放东西。
 */
const SKILL_SKELETON_DIRS = ['references', 'scripts'] as const

interface CreateSkillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  /** Space 所属 Organization ID；无 → 不写本地骨架（仅创建 DB 行） */
  organizationId: string | null
  /** 创建成功后留在 Skill 面板，由父级选中并展示详情 */
  onCreateSuccess?: (skillKey: string) => void
}

export const CreateSkillDialog: React.FC<CreateSkillDialogProps> = ({
  open, onOpenChange, spaceId, organizationId, onCreateSuccess,
}) => {
  const { t } = useTranslation('context')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<string>(SKILL_MARKET_CATEGORY_ORDER[0])
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const selectedAgentId = resolveAgentIdForOrganization(selectedAgent, organizationId)
  const createMutation = useCreateSkillMutation()

  // 名称是「显示名」（任意语言，含中文）；标识名是 Agent 用 /xxx 调用的英文 slug。
  // 标识名留空时从名称自动派生；纯中文名无法派生出有意义的英文标识，会回退成 skill。
  const trimmedSlug = slug.trim()
  const autoSlug = useMemo(() => slugifySkillName(name), [name])
  const effectiveSlug = trimmedSlug || autoSlug
  const canonicalPreview = useMemo(
    () => userCanonicalKeyFromSlug(effectiveSlug),
    [effectiveSlug],
  )
  // 用户手填了标识名但不是合法 kebab → 拦截并提示，避免静默被后端改写。
  const slugInvalid = trimmedSlug.length > 0 && !isValidKebabSlug(trimmedSlug)
  // 名称非空、未手填标识名、且自动派生回退成通用 skill（典型：纯中文名）→ 建议补英文标识。
  const suggestEnglishSlug
    = name.trim().length > 0 && trimmedSlug.length === 0 && autoSlug === 'skill'

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || slugInvalid) return
    try {
      const result = await createMutation.mutateAsync({
        // Skill 归属组织；创建后是否为 Agent 启用，统一留到 Skill 详情中操作。
        organization_id: organizationId ?? '',
        agent_id: selectedAgentId ?? undefined,
        name: name.trim(),
        description: description.trim(),
        category,
        ...(trimmedSlug ? { slug: trimmedSlug } : {}),
      })
      onOpenChange(false)
      setName('')
      setSlug('')
      setDescription('')
      setCategory(SKILL_MARKET_CATEGORY_ORDER[0])
      if (result?.skill_id) {
        const skillKey = result.skill_key || result.skill_id
        if (organizationId) {
          try {
            const fs = window.tabtin?.fileSystem
            const resolvedSlug = result.slug || effectiveSlug
            // 本地落盘必须与后端首次发布字节一致，避免新建后立即 dirty。
            const fromNormalized = Array.isArray(result.normalized_files)
              ? result.normalized_files.find((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
              : null
            const skeleton = fromNormalized?.content || result.skeleton_content || generateSkillSkeleton(
              result.name || name.trim(),
              result.description?.trim() || description.trim() || (result.name || name.trim()),
              category,
              resolvedSlug,
            )
            const written = await writeSkillContent({ spaceId, organizationId, skillKey, content: skeleton })
            // 建标准目录骨架（references/ + scripts/），让用户进编辑器即见目录结构。
            // 失败不阻断创建——空目录非关键，用户也可在编辑器里手动新建。
            const createDir = fs?.createDir
            if (written?.skillDir && createDir) {
              for (const dir of SKILL_SKELETON_DIRS) {
                try {
                  await createDir(joinPath(written.skillDir, dir))
                } catch {
                  // 单个骨架目录失败忽略
                }
              }
            }
          } catch {
            // 本地 skeleton 写入失败不阻断创建；编辑器会用内存模板兜底
          }
        }
        onCreateSuccess?.(skillKey)
        toast.success(t('skills.createSuccess'))
        toast.info(t('skills.enableAfterCreateHint'))
      }
    } catch (err) {
      log.error('创建 Skill 失败', { spaceId, category }, err)
      toast.error(t('skills.createFailed'))
    }
  }, [name, slugInvalid, trimmedSlug, effectiveSlug, description, category, spaceId, organizationId, selectedAgentId, createMutation, onOpenChange, onCreateSuccess, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 中间区滚动、页脚固定，避免较矮窗口中「取消/创建」被顶出弹窗。 */}
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col overflow-hidden">
        <ContextDialogHeader
          className="shrink-0 px-0 pt-0"
          icon={<Sparkles className="h-7 w-7" />}
          title={t('skills.createDialog.title')}
          description={t('skills.createDialog.description', { defaultValue: '创建一个可由 Agent 调用的 Skill 能力' })}
        />
        <DialogScrollBody className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className={cn('font-medium', 'text-foreground/80', CANVAS_TEXT_META_BASE)}>
              {t('skills.createDialog.nameLabel')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
            </label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('skills.createDialog.namePlaceholder')}
              autoFocus
              aria-required="true"
            />
            <p className={CANVAS_TEXT_META}>
              {t('skills.createDialog.nameHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className={cn('font-medium', 'text-foreground/80', CANVAS_TEXT_META_BASE)}>
              {t('skills.createDialog.slugLabel')}
            </label>
            <Input
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder={autoSlug}
              aria-invalid={slugInvalid}
            />
            {slugInvalid ? (
              <p className={cn('text-destructive', CANVAS_TEXT_META_BASE)}>
                {t('skills.createDialog.slugInvalid')}
              </p>
            ) : suggestEnglishSlug ? (
              <p className={cn('text-warning', CANVAS_TEXT_META_BASE)}>
                {t('skills.createDialog.slugChineseHint')}
              </p>
            ) : name.trim() ? (
              <p className={CANVAS_TEXT_META}>
                {t('skills.createDialog.slugPreview', {
                  slug: effectiveSlug,
                  key: canonicalPreview,
                })}
              </p>
            ) : (
              <p className={CANVAS_TEXT_META}>
                {t('skills.createDialog.slugHint')}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className={cn('font-medium', 'text-foreground/80', CANVAS_TEXT_META_BASE)}>
              {t('skills.createDialog.categoryLabel')}
            </label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKILL_MARKET_CATEGORY_ORDER.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`skills.marketplaceCategory.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className={cn('font-medium', 'text-foreground/80', CANVAS_TEXT_META_BASE)}>
              {t('skills.createDialog.descLabel')}
            </label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('skills.createDialog.descPlaceholder')}
              rows={3}
            />
          </div>
        </DialogScrollBody>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('skills.createDialog.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || slugInvalid || createMutation.isPending}
          >
            {createMutation.isPending
              ? t('skills.createDialog.creating')
              : t('skills.createDialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
