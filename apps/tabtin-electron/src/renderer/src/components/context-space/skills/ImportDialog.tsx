import React, { useState, useCallback, useRef } from 'react'
import {
  Dialog, DialogContent, DialogFooter, DialogScrollBody,
  Button, Input, toast,
} from '@components/ui'
import { Download, Link, FolderOpen, Package } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ContextDialogHeader } from '../ContextDialogHeader'
import { useImportSkillMutation, skillKeys } from '@/hooks/queries/skills'
import { useQueryClient } from '@tanstack/react-query'
import { useSpaceStore } from '@stores/useSpaceStore'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { SkillImportResult } from '@/skills/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')
import { arrayBufferToBase64, isLikelyBinaryPath, MAX_SKILL_BUNDLE_BYTES, shouldIgnoreSkillEntryName } from './skillPublishFiles'
import {
  groupFilesBySkill,
  isIgnoredSkillImportPath,
  materializeImportedSkill,
  type ImportFileEntry,
  type SkillImportGroup,
} from './skillImport'
import { mapSkillImportError } from './mapSkillImportError'
import { resolveSkillLocalPath } from './skillMdUtils'
import {
  anyImportedAlreadyExists,
  toastImportOutcome,
} from './toastImportOutcome'
import {
  buildSkillImportRequestItems,
  resolveAgentIdForOrganization,
} from './skillAgentAssignment'

type ImportTab = 'folder' | 'url' | 'npm'

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  /** 物化导入文件到本地 platform-data 必传（避免落 `_unscoped` / 导入后空壳）。 */
  organizationId: string | null
  onImportSuccess?: (skillKey: string) => void
}

export const ImportDialog: React.FC<ImportDialogProps> = ({
  open, onOpenChange, spaceId, organizationId, onImportSuccess,
}) => {
  const { t } = useTranslation('context')
  const [tab, setTab] = useState<ImportTab>('folder')
  const [url, setUrl] = useState('')
  const [npmPackage, setNpmPackage] = useState('')
  const [npmInstalling, setNpmInstalling] = useState(false)
  // 选中文件按「每个 SKILL.md 目录 = 一个 skill」拆成多组（一个仓库可能含多个独立 skill）。
  const [skillGroups, setSkillGroups] = useState<SkillImportGroup[]>([])
  const [skippedFiles, setSkippedFiles] = useState<string[]>([])
  const [folderName, setFolderName] = useState('')
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  // ：技能启用锚点从 Space 迁到 Agent；selectedAgent 仅作为当前 Workspace 的回退。
  const selectedAgentId = resolveAgentIdForOrganization(selectedAgent, organizationId)
  const queryClient = useQueryClient()
  const importMutation = useImportSkillMutation()
  // ：持久挂载 hidden input（Dialog 生命周期内、不随 tab 卸载），避免临时 createElement + click() 二次唤起静默失败。
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const reset = useCallback(() => {
    setUrl('')
    setNpmPackage('')
    setNpmInstalling(false)
    setSkillGroups([])
    setSkippedFiles([])
    setFolderName('')
  }, [])

  const materializeOkResult = useCallback(async (
    result: SkillImportResult,
    fallbackFiles?: ImportFileEntry[],
  ) => {
    const key = result?.skill_key || result?.skill_id
    if (!key || !organizationId) return key || ''
    const normalizedFiles = Array.isArray(result?.normalized_files)
      ? result.normalized_files
        .filter((item): item is { path: string; content: string; encoding?: 'base64' } =>
          typeof item?.path === 'string' && typeof item?.content === 'string')
        .map((item) => ({
          path: item.path,
          content: item.content,
          ...(item.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
        }))
      : (fallbackFiles || [])
    if (normalizedFiles.length === 0) return key
    try {
      const resolved = await resolveSkillLocalPath({ spaceId, organizationId, skillKey: key })
      const shouldMaterialize = Boolean(resolved?.skillDir) && (
        !result?.already_exists || !resolved?.mdExists
      )
      if (shouldMaterialize && resolved?.skillDir) {
        await materializeImportedSkill(window.tabtin.fileSystem, resolved.skillDir, normalizedFiles)
      } else if (!result?.already_exists && !resolved?.skillDir) {
        toast.warning(t('skills.importDialog.materializeFailed', {
          defaultValue: '已导入到云端，但本地文件写入失败；启用前请先打开编辑器确认内容',
        }))
      }
    } catch (materializeErr) {
      log.warn('导入后本地物化失败', { skillKey: key, spaceId }, materializeErr)
      if (!result?.already_exists) {
        toast.warning(t('skills.importDialog.materializeFailed', {
          defaultValue: '已导入到云端，但本地文件写入失败；启用前请先打开编辑器确认内容',
        }))
      }
    }
    return key
  }, [organizationId, spaceId, t])

  /** 一次 POST items[] 入库并物化到本地。 */
  const importBatch = useCallback(async (
    items: Array<{ name?: string; files?: ImportFileEntry[]; url?: string }>,
  ) => {
    const batch = await importMutation.mutateAsync({
      // ：导入锚点走 organization_id + agent_id；导入后由用户在面板按需启用。
      organization_id: organizationId ?? '',
      agent_id: selectedAgentId ?? undefined,
      items: buildSkillImportRequestItems(items),
    })
    const results = Array.isArray(batch?.results) && batch.results.length > 0
      ? batch.results
      : [{
          index: 0,
          ok: true,
          already_exists: Boolean(batch?.already_exists),
          skill: batch,
          normalized_files: batch?.normalized_files,
          enabled_agent_ids: batch?.enabled_agent_ids,
        }]
    const imported: Array<{ key: string; result: SkillImportResult }> = []
    const failed: string[] = []
    let firstErrorMessage: string | undefined
    let anyAlreadyExists = false

    for (const row of results) {
      if (!row?.ok) {
        failed.push(items[row?.index ?? 0]?.name || `item-${row?.index ?? '?'}`)
        if (!firstErrorMessage && row?.error?.message) {
          firstErrorMessage = row.error.message
        }
        continue
      }
      const skillResult = (row.skill || row) as SkillImportResult
      if (row.already_exists || skillResult.already_exists) anyAlreadyExists = true
      const fallback = items[row.index]?.files
      const withFiles: SkillImportResult = {
        ...skillResult,
        normalized_files: row.normalized_files || skillResult.normalized_files,
        already_exists: row.already_exists ?? skillResult.already_exists,
      }
      const key = await materializeOkResult(withFiles, fallback)
      if (key) imported.push({ key, result: withFiles })
    }

    // 单元素扁平响应也会挂顶层 already_exists；与 results[] 取并集，防嵌套/扁平偶发不一致。
    if (batch?.already_exists) anyAlreadyExists = true

    return {
      okCount: imported.length,
      failed,
      imported,
      firstErrorMessage,
      anyAlreadyExists,
      summary: batch?.summary,
    }
  }, [
    importMutation, materializeOkResult,
    organizationId, selectedAgentId,
  ])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return

    const files: ImportFileEntry[] = []
    const skipped: string[] = []
    let totalBytes = 0

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const relativePath = (file as any).webkitRelativePath || file.name
      const parts = relativePath.split('/')
      // 去掉用户所选文件夹这一层前缀，保留仓库内相对路径（如 skills/nature-citation/SKILL.md）。
      const rel = parts.length > 1 ? parts.slice(1).join('/') : parts[0]

      // 对齐发布 / 后端：跳过 node_modules、__pycache__、隐藏文件（.DS_Store 等）。
      if (isIgnoredSkillImportPath(rel) || parts.some((part: string) => shouldIgnoreSkillEntryName(part))) {
        continue
      }

      // 大小守门：单文件 + 总包 ≤ 20MB（与发布、后端解码字节预算一致）。超限跳过。
      if (file.size > MAX_SKILL_BUNDLE_BYTES || totalBytes + file.size > MAX_SKILL_BUNDLE_BYTES) {
        skipped.push(rel)
        continue
      }

      try {
        // svg 是文本 XML（不在二进制名单），与其它文本一样直接读文本导入。
        // 真二进制（png / 图标 / 字体…）读字节 → base64，标 encoding，后端原样落盘。
        if (isLikelyBinaryPath(rel)) {
          const buf = await file.arrayBuffer()
          files.push({ path: rel, content: arrayBufferToBase64(buf), encoding: 'base64' })
        } else {
          const content = await file.text()
          files.push({ path: rel, content })
        }
        totalBytes += file.size
      } catch {
        skipped.push(rel)
      }
    }

    const first = fileList[0]
    const webkitPath = (first as any).webkitRelativePath || ''
    const dirName = webkitPath ? webkitPath.split('/')[0] : first.name

    // 按 SKILL.md 所在目录拆成多个独立 skill（单 skill 仓库 → 单组）。
    const groups = groupFilesBySkill(files, dirName || 'skill')

    setSkippedFiles(skipped)
    setSkillGroups(groups)
    setFolderName(dirName || '')
    if (groups.length === 0 && files.length > 0) {
      toast.error(t('skills.importDialog.noSkillFound', { defaultValue: '未找到 SKILL.md，无法导入' }))
    }

    if (e.target) e.target.value = ''
  }, [t])

  const handleSingleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    const file = fileList[0]
    if (file.name.toUpperCase() !== 'SKILL.MD') {
      setSkillGroups([])
      setFolderName('')
      toast.error(t('skills.importDialog.mustSelectSkillMd', {
        defaultValue: '仅支持导入 SKILL.md，普通 README.md 不能直接导入',
      }))
      if (e.target) e.target.value = ''
      return
    }
    try {
      const content = await file.text()
      setSkillGroups([{ name: 'skill', files: [{ path: 'SKILL.md', content }] }])
      setSkippedFiles([])
      setFolderName(file.name)
    } catch {
      toast.error(t('skills.importDialog.readError'))
    }
    if (e.target) e.target.value = ''
  }, [t])

  const isValidUrl = url.trim().startsWith('https://')
  const npmPkgNormalized = npmPackage.trim().replace(/^npm:/i, '').trim()
  const canSubmit = tab === 'url'
    ? isValidUrl
    : tab === 'npm'
      ? npmPkgNormalized.length > 0
      : skillGroups.length > 0
  const isSubmitting = importMutation.isPending || npmInstalling

  const handleSubmit = useCallback(async () => {
    try {
      if (tab === 'npm') {
        const api = window.tabtin?.skill?.installNpm
        if (!api) {
          toast.error(t('skills.importDialog.npmUnavailable'))
          return
        }
        setNpmInstalling(true)
        try {
          const result = await api({
            package: npmPkgNormalized,
            spaceId,
            organizationId,
            importToSpace: true,
          })
          if (!result?.success) {
            toast.error(mapSkillImportError(
              result?.error || t('skills.importDialog.npmFailed'),
              t,
            ))
            return
          }
          const data = result.data
          const imported = Array.isArray(data?.imported) ? data.imported : []
          const importedResults = imported as SkillImportResult[]
          void queryClient.invalidateQueries({ queryKey: skillKeys.list(organizationId ?? '') })
          if (data?.note) {
            toast.warning(data.note)
          } else if (importedResults.length > 0) {
            toastImportOutcome(
              toast,
              t,
              anyImportedAlreadyExists(importedResults),
            )
          } else {
            toast.success(t('skills.importDialog.npmSuccessEmpty'))
          }

          const first = importedResults[0]
          const firstKey = first?.skill_key || first?.skill_id || ''
          if (firstKey && onImportSuccess) onImportSuccess(firstKey)
          reset()
          onOpenChange(false)
        } finally {
          setNpmInstalling(false)
        }
        return
      }

      if (tab === 'url') {
        const { okCount, imported, firstErrorMessage, anyAlreadyExists } = await importBatch([
          { url: url.trim() },
        ])
        if (okCount === 0) {
          toast.error(firstErrorMessage || t('skills.importDialog.errors.generic', {
            defaultValue: '导入失败，请检查 SKILL.md 格式与文件大小后重试',
          }))
          return
        }
        const first = imported[0]
        toastImportOutcome(
          toast,
          t,
          Boolean(anyAlreadyExists || first?.result?.already_exists),
        )
        if (first?.key && onImportSuccess) onImportSuccess(first.key)
        reset()
        onOpenChange(false)
        return
      }

      const { okCount, failed, imported, firstErrorMessage, anyAlreadyExists } = await importBatch(
        skillGroups.map((g) => ({ name: g.name, files: g.files })),
      )
      const first = imported[0]
      if (okCount === 0) {
        toast.error(firstErrorMessage || (failed.length
          ? t('skills.importDialog.errors.generic', {
            defaultValue: '导入失败，请检查 SKILL.md 格式与文件大小后重试',
          })
          : t('skills.importDialog.noSkillFound', { defaultValue: '未找到 SKILL.md，无法导入' })))
        return
      }
      if (skillGroups.length > 1) {
        toast.success(t('skills.importDialog.importedMulti', {
          ok: okCount, total: skillGroups.length,
          defaultValue: `已导入 ${okCount}/${skillGroups.length} 个 skill${failed.length ? `（${failed.length} 个失败）` : ''}`,
        }))
      } else {
        toastImportOutcome(
          toast,
          t,
          Boolean(anyAlreadyExists || first?.result?.already_exists),
        )
      }
      if (first?.key && onImportSuccess) onImportSuccess(first.key)
      reset()
      onOpenChange(false)
    } catch (err) {
      toast.error(mapSkillImportError(err, t))
    }
  }, [
    tab, url, npmPkgNormalized, skillGroups, spaceId, organizationId,
    importBatch,
    onImportSuccess, onOpenChange, reset, t,
    queryClient,
  ])

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // 导入进行中禁止关窗 / 重置，避免半截请求被用户打断后状态错乱。
        if (isSubmitting) return
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      {/* 与 CreateSkillDialog 同款：中间滚动、页脚钉住，避免按钮溢出白底。 */}
      <DialogContent
        className="flex max-h-[85vh] max-w-md flex-col overflow-hidden"
        closeClassName={isSubmitting ? 'pointer-events-none opacity-50' : undefined}
        onPointerDownOutside={(event) => {
          if (isSubmitting) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (isSubmitting) event.preventDefault()
        }}
      >
        <ContextDialogHeader
          className="shrink-0 px-0 pt-0"
          icon={<Download className="h-7 w-7" />}
          title={t('skills.importDialog.title')}
          description={t('skills.importDialog.description')}
        />

        <div className="flex shrink-0 items-center gap-1 border-b border-border/40">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setTab('folder')}
            className={cn(
              'border-b-2 px-3 py-1.5 text-body transition-colors',
              'disabled:pointer-events-none disabled:opacity-50',
              tab === 'folder'
                ? 'border-primary text-foreground'
                : 'border-transparent text-foreground/60 hover:text-foreground/80',
            )}
          >
            <span className="flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5" />
              {t('skills.importDialog.tabFolder')}
            </span>
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setTab('url')}
            className={cn(
              'border-b-2 px-3 py-1.5 text-body transition-colors',
              'disabled:pointer-events-none disabled:opacity-50',
              tab === 'url'
                ? 'border-primary text-foreground'
                : 'border-transparent text-foreground/60 hover:text-foreground/80',
            )}
          >
            <span className="flex items-center gap-1.5">
              <Link className="h-3.5 w-3.5" />
              {t('skills.importDialog.tabUrl')}
            </span>
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setTab('npm')}
            className={cn(
              'border-b-2 px-3 py-1.5 text-body transition-colors',
              'disabled:pointer-events-none disabled:opacity-50',
              tab === 'npm'
                ? 'border-primary text-foreground'
                : 'border-transparent text-foreground/60 hover:text-foreground/80',
            )}
          >
            <span className="flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" />
              {t('skills.importDialog.tabNpm')}
            </span>
          </button>
        </div>

        <DialogScrollBody className="py-3">
          <input
            ref={(element) => {
              folderInputRef.current = element
              if (element) {
                element.setAttribute('webkitdirectory', '')
                element.setAttribute('directory', '')
              }
            }}
            type="file"
            className="hidden"
            multiple
            disabled={isSubmitting}
            onChange={(event) => { void handleFileSelect(event) }}
          />
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".md"
            disabled={isSubmitting}
            onChange={(event) => { void handleSingleFile(event) }}
          />
          {tab === 'folder' ? (
            <div className="space-y-3">
              <p className={CANVAS_TEXT_META}>
                {t('skills.importDialog.folderHint')}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => {
                    log.info('打开本地目录选择器', { spaceId })
                    folderInputRef.current?.click()
                  }}
                >
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  {t('skills.importDialog.selectFolder')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => {
                    log.info('打开本地 SKILL.md 选择器', { spaceId })
                    fileInputRef.current?.click()
                  }}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t('skills.importDialog.selectFile')}
                </Button>
              </div>
              {skillGroups.length > 0 && (
                <div className="rounded-md border border-border/20 bg-muted/10 p-2.5">
                  <p className="text-body font-medium">{folderName}</p>
                  {skillGroups.length > 1 ? (
                    <>
                      <p className={CANVAS_TEXT_META}>
                        {t('skills.importDialog.multiSkillDetected', {
                          count: skillGroups.length,
                          defaultValue: `发现 ${skillGroups.length} 个 skill，将分别导入为独立 skill：`,
                        })}
                      </p>
                      <p className={cn('mt-1', 'break-all', CANVAS_TEXT_META)}>
                        {skillGroups.map(g => g.name).join('、')}
                      </p>
                    </>
                  ) : (
                    <p className={CANVAS_TEXT_META}>
                      {t('skills.importDialog.fileCount', { count: skillGroups[0]?.files.length ?? 0 })}
                    </p>
                  )}
                  {skippedFiles.length > 0 && (
                    <p className={cn('text-amber-600', 'dark:text-amber-400', 'mt-1', CANVAS_TEXT_MICRO)}>
                      {t('skills.importDialog.skippedFiles', {
                        files: skippedFiles.join(', '),
                        defaultValue: `以下文件过大或读取失败，已跳过：${skippedFiles.join(', ')}`,
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : tab === 'url' ? (
            <div className="space-y-3">
              <p className={CANVAS_TEXT_META}>
                {t('skills.importDialog.urlHint')}
              </p>
              <Input
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://github.com/user/repo/raw/main/skills/my-skill/SKILL.md"
                autoFocus
                disabled={isSubmitting}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <p className={CANVAS_TEXT_META}>
                {t('skills.importDialog.npmHint')}
              </p>
              <Input
                value={npmPackage}
                onChange={e => setNpmPackage(e.target.value)}
                placeholder="https://github.com/anthropics/skills --skill algorithmic-art"
                autoFocus
                disabled={isSubmitting}
              />
            </div>
          )}
        </DialogScrollBody>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            disabled={isSubmitting}
            onClick={() => { reset(); onOpenChange(false) }}
          >
            {t('skills.importDialog.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting
              ? t('skills.importDialog.importing')
              : t('skills.importDialog.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
