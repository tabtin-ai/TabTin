import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, FilePlus, FolderPlus, Lock, Pencil, Save, Sparkles } from 'lucide-react'
import {
  Dialog, DialogContent, DialogFooter,
  Button, ScrollArea, toast, OverlayContainerProvider,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  usePublishSkillMutation,
  useSkillVersionsListQuery,
  skillKeys,
} from '@/hooks/queries/skills'
import type { SkillIndexEntry } from '@/skills/types'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { FileTree } from '@components/context-space/folder/FileTree'
import type { FileEntry } from '@components/context-space/folder/types'
import {
  useFileTreeActions,
  depthForNewItem,
  type FileTreeNewItemState,
} from '@components/shared/file-ops'
import { getBaseName, getMonacoLanguage, getParentPath, joinPath, normalizePathSeparators } from '@components/shared/file-utils'
import {
  applySkillDisplayNameToSkillMd,
  generateSkillSkeleton,
  ensureSkillMdDescription,
  parseSkillMd,
  stripSkillMdFileVersion,
  writeSkillContent,
  resolveSkillLocalPath,
} from './skillMdUtils'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')
import {
  coerceSemVerParts,
  formatSemVer,
  initialPublishVersionParts,
  maxSemVerLabel,
  normalizeVersionPart,
  validatePublishSemVer,
  type SemVerParts,
} from './skillSemver'
import { resolveSkillDisplayName } from './skillSlug'
import { collectSkillFiles, hasSkillMd, MAX_SKILL_FILE_BYTES } from './skillPublishFiles'
import { ContextDialogHeader } from '../ContextDialogHeader'

// Monaco 很重，懒加载（与 TextFileEditor 同款）。markdown / 各语言高亮用 Monaco 内置。
const CodeEditor = lazy(() =>
  import('@components/shared/file-preview/CodeEditor').then(m => ({ default: m.CodeEditor })),
)
const MarkdownViewer = lazy(() =>
  import('@components/shared/file-preview/MarkdownViewer').then(m => ({ default: m.MarkdownViewer })),
)

interface SkillEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: SkillIndexEntry
  spaceId: string
  /** 写本地 skill 目录必传——避免落到 `_unscoped` 而 Registry 扫不到。 */
  organizationId: string | null
  /**
   * 只读查看模式：禁用增删改 / 保存 / 发布，仅浏览文件树与内容。
   * installed / builtin / team 等「不可编辑来源」用——同一个多文件模态的两种模式之一。
   */
  readOnly?: boolean
  onSaved?: () => void
}

type EditorMode = 'edit' | 'preview'
type SelectedStatus = 'loading' | 'binary' | 'too-large' | 'error'
type VersionBumpKind = 'major' | 'minor' | 'patch'

const EditorLoading: React.FC = () => (
  <div className="space-y-2 p-4">
    {[1, 2, 3, 4].map(i => (
      <div key={i} className="h-3 animate-pulse rounded bg-muted/40" style={{ width: `${85 - i * 12}%` }} />
    ))}
  </div>
)

function partsToNumbers(parts: SemVerParts | null): [number, number, number] {
  if (!parts) return [0, 0, 0]
  return [parts.major, parts.minor, parts.patch].map(value => Number(value || 0)) as [number, number, number]
}

function bumpVersion(label: string | null | undefined, kind: VersionBumpKind): SemVerParts {
  const parsed = coerceSemVerParts(label || '')
  const [major, minor, patch] = partsToNumbers(parsed)
  if (!parsed) return initialPublishVersionParts()
  if (kind === 'major') return { major: String(major + 1), minor: '0', patch: '0' }
  if (kind === 'minor') return { major: String(major), minor: String(minor + 1), patch: '0' }
  return { major: String(major), minor: String(minor), patch: String(patch + 1) }
}

function versionPartOrZero(value: string): string {
  return normalizeVersionPart(value) || '0'
}

const VersionPublishDialog: React.FC<{
  open: boolean
  currentVersion: string | null | undefined
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (versionLabel: string) => void
}> = ({ open, currentVersion, saving, onOpenChange, onConfirm }) => {
  const { t } = useTranslation('context')
  const [bumpKind, setBumpKind] = useState<VersionBumpKind>('patch')
  const [parts, setParts] = useState<SemVerParts>(() => bumpVersion(currentVersion, 'patch'))

  useEffect(() => {
    if (!open) return
    setBumpKind('patch')
    setParts(bumpVersion(currentVersion, 'patch'))
  }, [currentVersion, open])

  const versionLabel = formatSemVer({
    major: versionPartOrZero(parts.major),
    minor: versionPartOrZero(parts.minor),
    patch: versionPartOrZero(parts.patch),
  })
  const currentLabel = coerceSemVerParts(currentVersion || '')
    ? formatSemVer(coerceSemVerParts(currentVersion || '')!)
    : t('skills.versionPublish.noCurrent')

  const handleBump = (kind: VersionBumpKind) => {
    setBumpKind(kind)
    setParts(bumpVersion(currentVersion, kind))
  }

  const updatePart = (key: keyof SemVerParts, value: string) => {
    setParts(prev => ({ ...prev, [key]: normalizeVersionPart(value) }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<Sparkles className="h-7 w-7" />}
          title={t('skills.versionPublish.title')}
          description={t('skills.versionPublish.description', { current: currentLabel })}
        />

        <div className="space-y-4 py-2">
          <div className="grid gap-2">
            {(['major', 'minor', 'patch'] as const).map(kind => (
              <button
                key={kind}
                type="button"
                disabled={saving}
                onClick={() => handleBump(kind)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left transition-colors',
                  bumpKind === kind
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border/40 hover:bg-muted/20',
                )}
              >
                <div className="text-body font-medium">
                  {t(`skills.versionPublish.bump.${kind}.title`)}
                </div>
                <div className={CANVAS_TEXT_META}>
                  {t(`skills.versionPublish.bump.${kind}.description`)}
                </div>
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className={cn('font-medium', CANVAS_TEXT_META)}>
              {t('skills.versionPublish.versionLabel')}
            </div>
            <div className="flex items-center gap-1.5">
              {(['major', 'minor', 'patch'] as const).map((key, index) => (
                <React.Fragment key={key}>
                  {index > 0 && <span className="text-body text-muted-foreground/60">.</span>}
                  <input
                    value={parts[key]}
                    disabled={saving}
                    onChange={event => updatePart(key, event.target.value)}
                    className="h-9 w-16 rounded-md border border-input bg-background px-2 text-center font-mono text-body outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    inputMode="numeric"
                    aria-label={t(`skills.versionPublish.part.${key}`)}
                  />
                </React.Fragment>
              ))}
            </div>
            <div className={CANVAS_TEXT_META}>
              {t('skills.versionPublish.willPublish', { version: versionLabel })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('skills.versionPublish.cancel')}
          </Button>
          <Button onClick={() => onConfirm(versionLabel)} disabled={saving}>
            {saving ? t('skills.editor.saving') : t('skills.versionPublish.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 删除 / 重命名后清理受影响的内存缓冲：精确路径 + （目录时）其子树。 */
function dropBufferKeys(
  map: Record<string, string>,
  basePath: string,
  isDir: boolean,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    if (key === basePath) continue
    if (isDir && key.startsWith(`${basePath}/`)) continue
    next[key] = value
  }
  return next
}

/** 文件重命名 / 移动：迁移单文件缓冲键（保留未保存编辑）。 */
function renameBufferKey(
  map: Record<string, string>,
  oldPath: string,
  newPath: string,
): Record<string, string> {
  if (map[oldPath] === undefined) return map
  const { [oldPath]: value, ...rest } = map
  return { ...rest, [newPath]: value }
}

/** 粗略判断绝对路径（POSIX `/` 或 Windows `X:\` / `X:/`）——只读模式用 `skill.path` 当目录前的护栏。 */
function isAbsolutePath(p: string | undefined | null): p is string {
  if (!p) return false
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

/** FileTree / joinPath 统一用正斜杠键；Windows resolve-path 返回反斜杠时必须先 normalize。 */
function normalizeSkillDir(dir: string): string {
  const normalized = normalizePathSeparators(dir)
  if (normalized === '/') return normalized
  if (/^[A-Za-z]:\/+$/.test(normalized)) return normalized.slice(0, 3)
  return normalized.replace(/\/+$/, '')
}

/**
 * SkillEditorDialog —— Skill 目录的多文件模态（左文件树 + 右编辑器），两种模式：
 *
 * Skill 本质是一个目录（SKILL.md + references/ + scripts/ …），不是单个文件。
 * - **编辑模式**（默认，可编辑来源 / 「我的」）：
 *   - 左侧文件树复用 `FileTree` + `useFileTreeActions`（增删/重命名/移动），底层走 `fs:*` IPC。
 *   - 右侧 SKILL.md 给 edit/preview 切换；其它文本按扩展名高亮编辑；二进制/超大只读提示。
 *   - 保存：写所有 dirty 文件（SKILL.md 走 `skill:write-content` 触发 registry rescan，其它走
 *     `fs:writeFile`），再递归收集目录成 `files[]` 同步当前版本（过滤二进制/超大、守 20MB）。
 * - **只读查看模式**（`readOnly`，不可编辑来源 installed/builtin/team）：
 *   - 文件树隐藏「新建/重命名/删除/移动」入口（不传对应回调即自动只读）。
 *   - 右侧编辑器 `readOnly`，无 onChange/onSave；隐藏「保存」。
 *   - skillDir 解析三级回退：`skill.path`（registry 扫到的真实目录，builtin 子目录天然完整）→
 *     `skill:resolve-path`（user 来源）→ 拿不到目录则单文件降级（只读展示 SKILL.md，不白屏）。
 */
export const SkillEditorDialog: React.FC<SkillEditorDialogProps> = ({
  open, onOpenChange, skill, spaceId, organizationId, readOnly = false, onSaved,
}) => {
  const { t } = useTranslation('context')
  const queryClient = useQueryClient()
  const publishMutation = usePublishSkillMutation()
  const { refetch: refetchVersions } = useSkillVersionsListQuery(
    open && !readOnly ? skill.skill_id : null,
  )
  const skillKey = skill.skill_key || null
  // 右键菜单（ContextMenu）的 portal 容器：指向 DialogContent。否则菜单会 portal 到 body，
  // 落在 Radix Dialog(modal) 的 pointer-events:none 区域外，导致菜单项点不动。
  const contentRef = useRef<HTMLDivElement>(null)

  const [skillDir, setSkillDir] = useState<string | null>(null)
  const [bootstrapping, setBootstrapping] = useState(false)
  const [bootstrapError, setBootstrapError] = useState(false)
  // 只读降级：拿不到本地 skill 目录（如未落盘的 team skill）时，退化为「单文件只读」——
  // 直接展示 SKILL.md 内容、不开文件树，避免白屏。
  const [readOnlyFallback, setReadOnlyFallback] = useState<{ content: string } | null>(null)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedIsDir, setSelectedIsDir] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<{ path: string; status: SelectedStatus } | null>(null)

  const [buffers, setBuffers] = useState<Record<string, string>>({})
  const [originals, setOriginals] = useState<Record<string, string>>({})
  const buffersRef = useRef(buffers)
  buffersRef.current = buffers

  const [mode, setMode] = useState<EditorMode>('edit')
  const [saving, setSaving] = useState(false)
  const [versionPublishOpen, setVersionPublishOpen] = useState(false)
  const [publishedVersionBase, setPublishedVersionBase] = useState<string | null>(
    () => maxSemVerLabel([skill.latest_version_label || '']),
  )
  /** 标题栏展示名（可点即改）；与 SKILL.md 缓冲同步。 */
  const [headerDisplayName, setHeaderDisplayName] = useState(() => resolveSkillDisplayName(skill))
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 文件树刷新协议（与 FileExplorerPane 同款）。
  const [refreshToken, setRefreshToken] = useState(0)
  const [newItem, setNewItem] = useState<FileTreeNewItemState | null>(null)
  const [opsReload, setOpsReload] = useState<{ seq: number; dirs: string[] }>({ seq: 0, dirs: [] })

  const skillMdPath = useMemo(() => (skillDir ? joinPath(skillDir, 'SKILL.md') : null), [skillDir])

  const dirtyPaths = useMemo(
    () => Object.keys(buffers).filter(p => buffers[p] !== originals[p]),
    [buffers, originals],
  )
  const dirty = dirtyPaths.length > 0

  // 打开时解析 skill 目录。
  // - 编辑模式：本地无 SKILL.md 则用现有内容 / 骨架兜底写一份（建出可编辑目录）。
  // - 只读模式：三级回退拿目录（skill.path → resolve-path → 单文件降级），不写任何文件。
  useEffect(() => {
    if (!open) {
      setSkillDir(null)
      setSelectedPath(null)
      setSelectedIsDir(false)
      setPendingStatus(null)
      setBuffers({})
      setOriginals({})
      setMode('edit')
      setBootstrapError(false)
      setReadOnlyFallback(null)
      setNewItem(null)
      setVersionPublishOpen(false)
      setEditingTitle(false)
      setTitleDraft('')
      setHeaderDisplayName(resolveSkillDisplayName(skill))
      return
    }
    setHeaderDisplayName(resolveSkillDisplayName(skill))
    if (!skillKey) {
      setBootstrapError(true)
      return
    }
    let cancelled = false
    setBootstrapping(true)
    setBootstrapError(false)
    setReadOnlyFallback(null)

    // 只读：优先吃列表已给的真实目录（skill.path = registry 扫到的 SKILL.md 父目录，
    // builtin 的 references/ examples/ 等子目录天然完整）；再回退 resolve-path（user 来源）。
    // resolve-path 对 builtin 的 `app:foo/bar` slug 会因含 `/` 被 isValidSkillKey 拒，故顺序在后。
    const resolveReadOnlyDir = async (): Promise<string | null> => {
      if (isAbsolutePath(skill.path)) {
        try {
          const md = joinPath(skill.path, 'SKILL.md')
          const res = await window.tabtin.fileSystem.readFilePreview(md, { maxBytes: MAX_SKILL_FILE_BYTES })
          if (res?.success && res.data?.kind === 'text') return skill.path
        } catch {
          // skill.path 不可用就走 resolve-path
        }
      }
      if (organizationId) {
        try {
          const resolved = await resolveSkillLocalPath({ spaceId, organizationId, skillKey })
          if (resolved?.exists && resolved.mdExists) return resolved.skillDir
        } catch {
          // resolve-path 对非法 slug 抛 VALIDATION_ERROR —— 吞掉走单文件降级
        }
      }
      return null
    }

    // 只读降级：读 SKILL.md 全文（registry / sourceDocPath fallback），拿不到目录时单文件展示。
    const readSkillMdFallback = async (): Promise<string | null> => {
      try {
        const existing = await window.tabtin?.skill?.readContent?.({
          skillKey, spaceId, organizationId, sourceDocPath: skill.doc_path ?? undefined,
        })
        const content = existing?.content ?? null
        return content == null ? null : stripSkillMdFileVersion(content)
      } catch {
        return null
      }
    }

    void (async () => {
      try {
        if (readOnly) {
          const dir = await resolveReadOnlyDir()
          if (cancelled) return
          if (dir) {
            setSkillDir(normalizeSkillDir(dir))
            setSelectedPath(joinPath(dir, 'SKILL.md'))
            setSelectedIsDir(false)
            return
          }
          const content = await readSkillMdFallback()
          if (cancelled) return
          if (content != null) setReadOnlyFallback({ content })
          else setBootstrapError(true)
          return
        }

        // 编辑模式：写本地目录必须有 organizationId（避免落到 _unscoped）。
        if (!organizationId) {
          setBootstrapError(true)
          return
        }
        const resolved = await resolveSkillLocalPath({ spaceId, organizationId, skillKey })
        if (!resolved) throw new Error('skill:resolve-path unavailable')
        let dir = resolved.skillDir
        if (!resolved.mdExists) {
          let seed = ''
          try {
            const existing = await window.tabtin?.skill?.readContent?.({
              skillKey, spaceId, organizationId, sourceDocPath: skill.doc_path ?? undefined,
            })
            seed = stripSkillMdFileVersion(existing?.content ?? '')
          } catch {
            // 读不到现有内容就用骨架兜底
          }
          if (!seed.trim()) {
            const displayName = resolveSkillDisplayName(skill)
            seed = generateSkillSkeleton(
              displayName,
              skill.description || displayName || '',
              skill.category ?? undefined,
              skill.slug ?? undefined,
            )
          }
          const written = await writeSkillContent({
            spaceId,
            organizationId,
            skillKey,
            content: stripSkillMdFileVersion(seed),
          })
          dir = written.skillDir || dir
        }
        if (cancelled) return
        setSkillDir(normalizeSkillDir(dir))
        setSelectedPath(joinPath(dir, 'SKILL.md'))
        setSelectedIsDir(false)
      } catch {
        if (!cancelled) setBootstrapError(true)
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    })()
    return () => { cancelled = true }
    // 依赖用基础字段而非 skill 对象引用：避免列表 refetch 产生新对象时重跑、覆盖编辑缓冲。
  }, [
    open, readOnly, skillKey, organizationId, spaceId,
    skill.path, skill.doc_path, skill.description, skill.category, skill.slug,
    skill.display_name, skill.name, skill.skill_id,
  ])

  // 选中文件 → 读内容进缓冲（已加载过则跳过）。二进制 / 超大 / 出错走只读提示。
  useEffect(() => {
    if (!open || !selectedPath || selectedIsDir) return
    if (buffersRef.current[selectedPath] !== undefined) {
      setPendingStatus(null)
      return
    }
    const path = selectedPath
    let cancelled = false
    setPendingStatus({ path, status: 'loading' })
    void (async () => {
      try {
        const res = await window.tabtin.fileSystem.readFilePreview(path, { maxBytes: MAX_SKILL_FILE_BYTES })
        if (cancelled) return
        if (!res?.success || !res.data) {
          setPendingStatus({ path, status: 'error' })
          return
        }
        const data = res.data
        if (data.kind !== 'text') {
          setPendingStatus({ path, status: 'binary' })
          return
        }
        if (data.truncated || (typeof data.size === 'number' && data.size > MAX_SKILL_FILE_BYTES)) {
          setPendingStatus({ path, status: 'too-large' })
          return
        }
        const content = data.content ?? ''
        const displayContent = path === skillMdPath ? stripSkillMdFileVersion(content) : content
        setBuffers(prev => ({ ...prev, [path]: displayContent }))
        setOriginals(prev => ({ ...prev, [path]: displayContent }))
        setPendingStatus(null)
      } catch {
        if (!cancelled) setPendingStatus({ path, status: 'error' })
      }
    })()
    return () => { cancelled = true }
  }, [open, selectedPath, selectedIsDir, skillMdPath])

  const onRefreshTree = useCallback((parentPaths: string | string[]) => {
    const dirs = [...new Set((Array.isArray(parentPaths) ? parentPaths : [parentPaths]).filter(Boolean))]
    setOpsReload(s => ({ seq: s.seq + 1, dirs }))
    setRefreshToken(p => p + 1)
  }, [])

  const { createFile, createDirectory, rename, moveToDirectory, deleteItem } = useFileTreeActions({
    rootPath: skillDir,
    onRefresh: onRefreshTree,
    i18nNamespace: 'context',
    showSuccessToast: false,
  })

  const handleSelectFile = useCallback((entry: FileEntry) => {
    setSelectedPath(entry.path)
    setSelectedIsDir(entry.isDirectory)
  }, [])

  const resolveCreateParentPath = useCallback((): string => {
    if (!skillDir) return ''
    if (!selectedPath) return skillDir
    if (selectedIsDir) return selectedPath
    return getParentPath(selectedPath) || skillDir
  }, [skillDir, selectedPath, selectedIsDir])

  const startNewItem = useCallback((itemMode: 'file' | 'folder') => {
    if (!skillDir) return
    const parentPath = resolveCreateParentPath()
    setNewItem({
      mode: itemMode,
      parentPath,
      depth: depthForNewItem(parentPath, skillDir, false),
    })
  }, [skillDir, resolveCreateParentPath])

  const updateSelectedBuffer = useCallback((next: string) => {
    if (!selectedPath) return
    setBuffers(prev => ({ ...prev, [selectedPath]: next }))
    // 用户在编辑器里改了展示名时，标题栏跟着走。
    if (skillMdPath && selectedPath === skillMdPath) {
      const parsed = parseSkillMd(next)
      if (parsed.displayName.trim()) {
        setHeaderDisplayName(parsed.displayName.trim())
      }
    }
  }, [selectedPath, skillMdPath])

  const beginEditTitle = useCallback(() => {
    if (readOnly) return
    setTitleDraft(headerDisplayName)
    setEditingTitle(true)
    requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
  }, [readOnly, headerDisplayName])

  const commitEditTitle = useCallback(() => {
    if (!editingTitle) return
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === headerDisplayName) {
      setTitleDraft('')
      return
    }
    setHeaderDisplayName(next)
    setTitleDraft('')
    if (!skillMdPath) return

    const applyToContent = (content: string) => applySkillDisplayNameToSkillMd(content, next)

    const current = buffersRef.current[skillMdPath]
    if (current !== undefined) {
      const updated = applyToContent(current)
      setBuffers(prev => ({ ...prev, [skillMdPath]: updated }))
      buffersRef.current = { ...buffersRef.current, [skillMdPath]: updated }
      return
    }

    // SKILL.md 尚未进缓冲：先读盘再改，避免丢未加载内容。
    void (async () => {
      try {
        const res = await window.tabtin.fileSystem.readFilePreview(skillMdPath, {
          maxBytes: MAX_SKILL_FILE_BYTES,
        })
        const disk = res?.success && res.data?.kind === 'text'
          ? stripSkillMdFileVersion(res.data.content ?? '')
          : ''
        const updated = applyToContent(disk)
        setBuffers(prev => ({ ...prev, [skillMdPath]: updated }))
        setOriginals(prev => (
          prev[skillMdPath] === undefined
            ? { ...prev, [skillMdPath]: disk }
            : prev
        ))
        buffersRef.current = { ...buffersRef.current, [skillMdPath]: updated }
      } catch (err) {
        log.warn('标题改名同步 SKILL.md 失败', { detail: String(err) })
      }
    })()
  }, [editingTitle, titleDraft, headerDisplayName, skillMdPath])

  const validateSkillMdBeforePublish = useCallback(async (): Promise<boolean> => {
    if (!skillDir || !skillKey || !organizationId || !skillMdPath) {
      toast.error(t('skills.editor.saveFailed'))
      return false
    }
    let skillMdContent = buffersRef.current[skillMdPath]
    if (skillMdContent === undefined) {
      try {
        const res = await window.tabtin.fileSystem.readFilePreview(skillMdPath, { maxBytes: MAX_SKILL_FILE_BYTES })
        skillMdContent = res?.data?.content ?? ''
      } catch {
        skillMdContent = ''
      }
    }
    const ensured = ensureSkillMdDescription(skillMdContent)
    if (ensured !== skillMdContent) {
      setBuffers(prev => ({ ...prev, [skillMdPath]: ensured }))
      buffersRef.current = { ...buffersRef.current, [skillMdPath]: ensured }
      skillMdContent = ensured
    }
    const parsed = parseSkillMd(skillMdContent)
    if (!parsed.name.trim()) {
      toast.error(t('skills.editor.nameRequired'))
      return false
    }
    if (!parsed.description.trim()) {
      toast.error(t('skills.editor.descriptionRequired'))
      return false
    }
    return true
  }, [skillDir, skillKey, organizationId, skillMdPath, t])

  const refreshPublishedVersions = useCallback(async () => {
    const result = await refetchVersions()
    if (result.error) throw result.error
    const labels = [
      skill.latest_version_label || '',
      ...(result.data ?? []).map(version => version.version_label),
    ]
    const latest = maxSemVerLabel(labels)
    setPublishedVersionBase(latest)
    return { labels, latest }
  }, [refetchVersions, skill.latest_version_label])

  const handleSaveRequest = useCallback(async () => {
    if (!(await validateSkillMdBeforePublish())) return
    setSaving(true)
    try {
      await refreshPublishedVersions()
      setVersionPublishOpen(true)
    } catch (err) {
      log.warn('发布前刷新 Skill 版本失败', { skillId: skill.skill_id }, err)
      toast.error(t('skills.versionPublish.refreshFailed'))
    } finally {
      setSaving(false)
    }
  }, [refreshPublishedVersions, skill.skill_id, t, validateSkillMdBeforePublish])

  const handleSave = useCallback(async (versionLabel: string) => {
    if (!skillDir || !skillKey || !organizationId || !skillMdPath) {
      toast.error(t('skills.editor.saveFailed'))
      return
    }
    if (!(await validateSkillMdBeforePublish())) return
    setSaving(true)
    try {
      // 用户确认前再次读取服务端真源。弹窗打开期间若版本被推进，保留编辑内容，
      // 让用户基于新版本重新判断 A/B/C，不能静默改号后直接发布。
      const { labels, latest } = await refreshPublishedVersions()
      if (validatePublishSemVer(versionLabel, labels)) {
        toast.error(t('skills.versionPublish.versionChanged', {
          latest: latest ? `v${latest}` : t('skills.versionPublish.noCurrent'),
        }))
        return
      }

      // 1) 写所有 dirty 文件（本地保存）：SKILL.md 走 skill:write-content（触发 registry rescan），其它走 fs:writeFile。
      const currentBuffers = buffersRef.current
      const buffersToWrite = { ...currentBuffers }
      if (buffersToWrite[skillMdPath] !== undefined) {
        buffersToWrite[skillMdPath] = stripSkillMdFileVersion(buffersToWrite[skillMdPath])
      }
      const dirtyToWrite = Object.keys(buffersToWrite).filter(p => buffersToWrite[p] !== originals[p])
      for (const p of dirtyToWrite) {
        if (p === skillMdPath) {
          await writeSkillContent({ spaceId, organizationId, skillKey, content: buffersToWrite[p] })
        } else {
          const res = await window.tabtin.fileSystem.writeFile(p, buffersToWrite[p])
          if (!res?.success) throw new Error(res?.error || 'writeFile failed')
        }
      }

      // 2) 保存即发布一个新的数据库版本。版本号由后端发布记录维护，前端只从
      //    最新发布版本推导下一个版本，不再修改 SKILL.md frontmatter。
      const collected = await collectSkillFiles(skillDir, window.tabtin.fileSystem, buffersToWrite)
      if (!hasSkillMd(collected.files)) {
        throw new Error('collected files missing SKILL.md')
      }
      try {
        await publishMutation.mutateAsync({
          skillId: skill.skill_id,
          organization_id: organizationId ?? '',
          version_label: versionLabel,
          visibility: skill.visibility || 'private',
          change_note: '',
          files: collected.files,
        })
      } catch (err) {
        // 本地文件已写成功，仅发布新版本失败——透出后端具体原因。
        setBuffers({ ...buffersToWrite })
        setOriginals({ ...buffersToWrite })
        await queryClient.invalidateQueries({ queryKey: skillKeys.content(skillKey) })
        if (organizationId) {
          await queryClient.invalidateQueries({ queryKey: skillKeys.list(organizationId) })
        }
        onSaved?.()
        const publishError = err as {
          message?: string
          data?: { latest_version?: string }
        }
        if (publishError.data?.latest_version) {
          setPublishedVersionBase(publishError.data.latest_version)
          log.warn('Skill 发布版本冲突', {
            skillId: skill.skill_id,
            requestedVersion: versionLabel,
            latestVersion: publishError.data.latest_version,
          })
        }
        const msg = publishError.message
        toast.error(msg || t('skills.editor.syncVersionFailed', { defaultValue: '已保存到本地，但发布新版本失败' }))
        return
      }
      if (collected.skipped.length > 0) {
        toast.warning(t('skills.editorDialog.skippedFilesNote', { count: collected.skipped.length }))
      }

      await queryClient.invalidateQueries({ queryKey: skillKeys.content(skillKey) })
      if (organizationId) {
        await queryClient.invalidateQueries({ queryKey: skillKeys.list(organizationId) })
      }
      setBuffers({ ...buffersToWrite })
      setOriginals({ ...buffersToWrite })
      onSaved?.()
      toast.success(t('skills.editor.saveSuccess'))
      setVersionPublishOpen(false)
      onOpenChange(false)
    } catch (err) {
      log.error('保存 Skill 编辑失败', { skillKey, spaceId, skillId: skill.skill_id }, err)
      toast.error(t('skills.editor.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [
    skillDir, skillKey, organizationId, skillMdPath, originals, spaceId,
    skill.skill_id, skill.visibility, publishMutation, queryClient,
    onSaved, onOpenChange, validateSkillMdBeforePublish, refreshPublishedVersions, t,
  ])

  const isSkillMdSelected = Boolean(selectedPath && selectedPath === skillMdPath)
  const selectedBuffer = selectedPath ? buffers[selectedPath] : undefined
  const selectedIsText = selectedBuffer !== undefined
  const selectedLanguage = useMemo(
    () => (selectedPath ? getMonacoLanguage(getBaseName(selectedPath)) : 'plaintext'),
    [selectedPath],
  )
  const previewBody = useMemo(
    () => (isSkillMdSelected && selectedBuffer ? parseSkillMd(selectedBuffer).body : ''),
    [isSkillMdSelected, selectedBuffer],
  )

  // SKILL.md（含只读降级的单文件）才给 source(看原文)/preview(看渲染) 切换。
  const showModeToggle = (isSkillMdSelected && selectedIsText) || Boolean(readOnly && readOnlyFallback)

  const renderEditorArea = (): React.ReactNode => {
    if (bootstrapError) {
      return <p className={cn('p-4', 'text-destructive/80', CANVAS_TEXT_META_BASE)}>{t('skills.editorDialog.bootstrapError')}</p>
    }
    // 只读单文件降级：拿不到本地目录但读到了 SKILL.md 内容——展示正文（preview）/ 原文（edit），均只读。
    if (readOnly && readOnlyFallback) {
      if (mode === 'preview') {
        const body = parseSkillMd(readOnlyFallback.content).body
        return (
          <ScrollArea className="h-full">
            {body.trim() ? (
              <Suspense fallback={<EditorLoading />}>
                <MarkdownViewer content={body} className="!h-auto px-4 py-3" />
              </Suspense>
            ) : (
              <p className={cn('p-4', CANVAS_TEXT_META)}>{t('skills.detail.empty')}</p>
            )}
          </ScrollArea>
        )
      }
      return (
        <Suspense fallback={<EditorLoading />}>
          <CodeEditor
            key="readonly-fallback"
            value={readOnlyFallback.content}
            language="markdown"
            readOnly
            className="h-full w-full"
            editorOptions={{ padding: { top: 12, bottom: 12 } }}
          />
        </Suspense>
      )
    }
    if (bootstrapping || !skillDir) {
      return <EditorLoading />
    }
    if (!selectedPath || selectedIsDir) {
      return (
        <p className={cn('flex', 'h-full', 'items-center', 'justify-center', 'p-4', CANVAS_TEXT_META)}>
          {t('skills.editorDialog.selectFilePrompt')}
        </p>
      )
    }
    if (!selectedIsText) {
      const status = pendingStatus?.path === selectedPath ? pendingStatus.status : 'loading'
      if (status === 'loading') return <EditorLoading />
      const message = status === 'binary'
        ? t('skills.editorDialog.binaryNotEditable')
        : status === 'too-large'
          ? t('skills.editorDialog.fileTooLarge')
          : t('skills.editorDialog.loadFileError')
      return (
        <p className={cn('flex', 'h-full', 'items-center', 'justify-center', 'p-4', CANVAS_TEXT_META)}>
          {message}
        </p>
      )
    }
    // SKILL.md 预览态
    if (isSkillMdSelected && mode === 'preview') {
      return (
        <ScrollArea className="h-full">
          {previewBody.trim() ? (
            <Suspense fallback={<EditorLoading />}>
              <MarkdownViewer
                content={previewBody}
                filePath={skillMdPath ?? undefined}
                className="!h-auto px-4 py-3"
              />
            </Suspense>
          ) : (
            <p className={cn('p-4', CANVAS_TEXT_META)}>{t('skills.detail.empty')}</p>
          )}
        </ScrollArea>
      )
    }
    // 文本态（SKILL.md edit 或其它文本文件）——只读模式禁用 onChange/onSave 并传 readOnly。
    return (
      <Suspense fallback={<EditorLoading />}>
        <CodeEditor
          key={selectedPath}
          value={selectedBuffer ?? ''}
          language={isSkillMdSelected ? 'markdown' : selectedLanguage}
          readOnly={readOnly}
          onChange={readOnly ? undefined : updateSelectedBuffer}
          onSave={readOnly ? undefined : () => void handleSaveRequest()}
          className="h-full w-full"
          editorOptions={{ padding: { top: 12, bottom: 12 } }}
        />
      </Suspense>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* container={null} 覆盖 OverlayContainerContext：强制 Portal 到 body、fixed 全屏。
          [&>button.absolute]:hidden 隐藏 Dialog 内置右上角 X——底部已有「关闭」按钮；Esc / 点遮罩仍可关闭。 */}
      <DialogContent ref={contentRef} container={null} className="flex h-[85vh] w-[92vw] max-w-5xl flex-col gap-0 p-0 [&>button.absolute]:hidden">
        {/* OverlayContainerProvider(容器=DialogContent)：让内部文件树的右键 ContextMenu
            portal 进 dialog 可交互区，绕开 Dialog modal 对 body 的 pointer-events:none。 */}
        <OverlayContainerProvider containerRef={contentRef}>
        <ContextDialogHeader
          className="border-b border-border/40 px-4 py-3"
          icon={<Sparkles className="h-7 w-7" />}
          title={readOnly ? (
            headerDisplayName
          ) : editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => commitEditTitle()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitEditTitle()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditingTitle(false)
                  setTitleDraft('')
                }
              }}
              aria-label={t('skills.editorDialog.renameAria', { defaultValue: 'Skill 名称' })}
              className={cn(
                'w-full min-w-0 max-w-md truncate rounded-md border border-border/60 bg-background px-2 py-0.5',
                'text-title font-semibold text-foreground outline-none',
                'focus-visible:ring-1 focus-visible:ring-ring',
              )}
            />
          ) : (
            <button
              type="button"
              onClick={beginEditTitle}
              title={t('skills.editorDialog.renameHint', { defaultValue: '点击修改名称' })}
              className={cn(
                'max-w-md truncate rounded-md text-left text-title font-semibold text-foreground',
                'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'px-1 -mx-1',
              )}
            >
              {headerDisplayName}
            </button>
          )}
          description={(
            <span className="inline-flex min-w-0 items-center gap-2">
              {readOnly ? (
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  {t('skills.editorDialog.readOnlyBadge')}
                </span>
              ) : dirty ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {t('skills.editor.unsavedBadge')}
                </span>
              ) : !editingTitle ? (
                <span className="text-muted-foreground/50">
                  {t('skills.editorDialog.renameHint', { defaultValue: '点击名称即可修改' })}
                </span>
              ) : null}
            </span>
          )}
          actions={(
            <div className="flex items-center gap-1 shrink-0">
            {showModeToggle ? (
              <>
                <Button
                  variant={mode === 'edit' ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('h-7', 'px-2', CANVAS_TEXT_META)}
                  onClick={() => setMode('edit')}
                >
                  <Pencil className="mr-1 h-3 w-3" />
                  {t(readOnly ? 'skills.editor.source' : 'skills.editor.edit')}
                </Button>
                <Button
                  variant={mode === 'preview' ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('h-7', 'px-2', CANVAS_TEXT_META)}
                  onClick={() => setMode('preview')}
                >
                  <Eye className="mr-1 h-3 w-3" />
                  {t('skills.editor.preview')}
                </Button>
              </>
            ) : null}
            </div>
          )}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* 左：文件树。只读降级拿不到目录时整列隐藏——模态退化为单文件只读查看，不留空树栏。 */}
          {!(readOnly && readOnlyFallback) ? (
          <div className="flex w-60 shrink-0 flex-col border-r border-border/40">
            <div className="flex items-center justify-between gap-1 border-b border-border/30 px-2 py-1.5">
              <span className={cn('truncate', 'pl-1', 'font-medium', CANVAS_TEXT_META)}>
                {t('skills.editorDialog.filesLabel')}
              </span>
              {/* 只读模式不暴露新建入口（增删改/移动同时禁掉，见 FileTree 回调）。 */}
              {!readOnly ? (
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    title={t('skills.editorDialog.newFile')}
                    disabled={!skillDir}
                    onClick={() => startNewItem('file')}
                  >
                    <FilePlus className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    title={t('skills.editorDialog.newFolder')}
                    disabled={!skillDir}
                    onClick={() => startNewItem('folder')}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {skillDir ? (
                <FileTree
                  rootPath={skillDir}
                  kind="user"
                  refreshToken={refreshToken}
                  selectedFile={selectedPath}
                  onSelectFile={handleSelectFile}
                  newItem={readOnly ? null : newItem}
                  onNewItemChange={readOnly ? undefined : setNewItem}
                  onCreateFile={readOnly ? undefined : createFile}
                  onCreateDirectory={readOnly ? undefined : createDirectory}
                  isSandbox={false}
                  opsReload={opsReload}
                  onMoveEntry={readOnly ? undefined : async (sourcePath, targetDirPath) => {
                    const ok = await moveToDirectory(sourcePath, targetDirPath)
                    if (ok) {
                      const newPath = joinPath(targetDirPath, getBaseName(sourcePath))
                      setBuffers(prev => renameBufferKey(prev, sourcePath, newPath))
                      setOriginals(prev => renameBufferKey(prev, sourcePath, newPath))
                      if (selectedPath === sourcePath) setSelectedPath(newPath)
                    }
                    return ok
                  }}
                  onRenameFile={readOnly ? undefined : async (entry, newName) => {
                    const ok = await rename(entry.path, newName)
                    if (ok) {
                      const parent = getParentPath(entry.path) || skillDir
                      const newPath = joinPath(parent, newName)
                      if (entry.isDirectory) {
                        setBuffers(prev => dropBufferKeys(prev, entry.path, true))
                        setOriginals(prev => dropBufferKeys(prev, entry.path, true))
                        if (selectedPath === entry.path || selectedPath?.startsWith(`${entry.path}/`)) {
                          setSelectedPath(skillMdPath)
                          setSelectedIsDir(false)
                        }
                      } else {
                        setBuffers(prev => renameBufferKey(prev, entry.path, newPath))
                        setOriginals(prev => renameBufferKey(prev, entry.path, newPath))
                        if (selectedPath === entry.path) setSelectedPath(newPath)
                      }
                    }
                    return ok
                  }}
                  onDeleteFile={readOnly ? undefined : async (entry) => {
                    // SKILL.md 是 skill 必备文件，禁止删除。
                    if (entry.path === skillMdPath) {
                      toast.error(t('skills.editorDialog.skillMdProtected'))
                      return
                    }
                    await deleteItem(entry.path, entry.isDirectory)
                    setBuffers(prev => dropBufferKeys(prev, entry.path, entry.isDirectory))
                    setOriginals(prev => dropBufferKeys(prev, entry.path, entry.isDirectory))
                    if (selectedPath === entry.path || (entry.isDirectory && selectedPath?.startsWith(`${entry.path}/`))) {
                      setSelectedPath(skillMdPath)
                      setSelectedIsDir(false)
                    }
                  }}
                  className="h-full"
                />
              ) : (
                <EditorLoading />
              )}
            </div>
          </div>
          ) : null}

          {/* 右：编辑器 */}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {renderEditorArea()}
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-3 border-t border-border/40 px-4 py-3 space-y-0">
          {/* 只读没有 hint：文件树 + 无保存/增删控件已自解释，不再念一遍目录结构。 */}
          {!readOnly ? (
            <p className={cn('CANVAS_TEXT_META min-w-0 truncate', isSkillMdSelected && mode === 'preview' && 'invisible')}>
              {t('skills.editorDialog.dirHint')}
            </p>
          ) : (
            <span className="min-w-0" />
          )}
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('skills.editorDialog.close')}
            </Button>
            {/* 只读没有保存语义——隐藏「保存」。 */}
            {!readOnly ? (
              <Button size="sm" disabled={saving || !dirty} onClick={() => void handleSaveRequest()}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {saving ? t('skills.editor.saving') : t('skills.editor.saveAndPublish')}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
        {!readOnly ? (
          <VersionPublishDialog
            open={versionPublishOpen}
            onOpenChange={setVersionPublishOpen}
            currentVersion={publishedVersionBase}
            saving={saving}
            onConfirm={(versionLabel) => void handleSave(versionLabel)}
          />
        ) : null}
        </OverlayContainerProvider>
      </DialogContent>
    </Dialog>
  )
}
