import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitBranchMeta, GitBranchItem, GitWorktreeInfo, GitDiffSummary } from '@shared/git-types'
import {
  trackGetStatus,
  trackLoadData,
  trackRawDiff,
} from '../../../context-space/code-workspace/changesPerfMetrics'
import { invalidateDiffContentCache } from '../diffContentCache'

export interface GitOutcomeCard {
  kind: 'pr' | 'merge'
  title: string
  subtitle: string
  summary: GitDiffSummary | null
  lines: string[]
  link?: string
  timestamp: number
}

export interface ChangeFile {
  path: string
  status: string
  staged: boolean
  unstaged: boolean
  partiallyStaged: boolean
  added: number
  deleted: number
  untracked: boolean
  /** porcelain 未合并状态（UU/AA/DD/AU…），独占 Conflicts 区 */
  conflict: boolean
}

export type ChangeSectionId = 'conflicts' | 'staged' | 'unstaged'

export interface ChangeSections {
  conflicts: ChangeFile[]
  staged: ChangeFile[]
  unstaged: ChangeFile[]
}

/** Git short/porcelain 未合并组合：U*、*U、AA、DD */
export function isConflictEntry(x: string, y: string): boolean {
  if (x === '?' && y === '?') return false
  if (x === 'U' || y === 'U') return true
  if (x === 'A' && y === 'A') return true
  if (x === 'D' && y === 'D') return true
  return false
}

export interface ChangeGroup {
  key: string
  label: string
  files: ChangeFile[]
  added: number
  deleted: number
  allStaged: boolean
  noneStaged: boolean
}

function parseNumstat(diff: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>()
  const lines = diff.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    const path = parts.slice(2).join('\t')
    const renamed = path.match(/^.*\{(.+) => (.+)\}.*$/)
    const finalPath = renamed ? path.replace(/\{(.+) => (.+)\}/, '$2').replace(/\/+/g, '/') : path
    map.set(finalPath, { added, deleted })
  }
  return map
}

export function buildChangeFiles(
  entries: Record<string, { x: string; y: string }>,
  numstatHead: Map<string, { added: number; deleted: number }>,
  numstatUnstaged: Map<string, { added: number; deleted: number }>,
): ChangeFile[] {
  const files: ChangeFile[] = []
  for (const [path, entry] of Object.entries(entries)) {
    const x = entry.x === ' ' ? '' : entry.x
    const y = entry.y === ' ' ? '' : entry.y
    const untracked = entry.x === '?' && entry.y === '?'
    const conflict = !untracked && isConflictEntry(x, y)
    const stagedFlag = !untracked && !conflict && Boolean(x)
    const unstagedFlag = untracked || (!conflict && Boolean(y))
    const partiallyStaged = !untracked && !conflict && Boolean(x) && Boolean(y)
    // 冲突统一用 U，避免 AA/DD 被显示成「新增/删除」
    const status = conflict ? 'U' : untracked ? '?' : (x || y || '?')
    const stat = numstatHead.get(path) || numstatUnstaged.get(path) || { added: 0, deleted: 0 }
    files.push({
      path,
      status,
      staged: stagedFlag,
      unstaged: unstagedFlag,
      partiallyStaged,
      added: stat.added,
      deleted: stat.deleted,
      untracked,
      conflict,
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

/**
 * 按交付语义拆成三区。部分暂存文件同时出现在 staged 与 unstaged；
 * 冲突文件只进 conflicts，不参与批量 stage/discard。
 */
export function partitionChangeFiles(files: ChangeFile[]): ChangeSections {
  const conflicts: ChangeFile[] = []
  const staged: ChangeFile[] = []
  const unstaged: ChangeFile[] = []
  for (const file of files) {
    if (file.conflict) {
      conflicts.push(file)
      continue
    }
    if (file.staged) staged.push(file)
    if (file.unstaged || file.untracked) unstaged.push(file)
  }
  return { conflicts, staged, unstaged }
}

export function groupChangeFiles(files: ChangeFile[]): ChangeGroup[] {
  const buckets = new Map<string, ChangeFile[]>()
  for (const file of files) {
    const idx = file.path.indexOf('/')
    const key = idx === -1 ? '·' : file.path.slice(0, idx) + '/'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(file)
  }
  const groups: ChangeGroup[] = []
  for (const [key, list] of buckets.entries()) {
    let added = 0
    let deleted = 0
    let allStaged = list.length > 0
    let noneStaged = true
    for (const f of list) {
      added += f.added
      deleted += f.deleted
      if (!f.staged || f.partiallyStaged) allStaged = false
      if (f.staged) noneStaged = false
    }
    groups.push({
      key,
      label: key === '·' ? '(根目录)' : key,
      files: list,
      added,
      deleted,
      allStaged,
      noneStaged,
    })
  }
  groups.sort((a, b) => b.files.length - a.files.length)
  return groups
}

export function makeOutcomeResourceId(kind: 'pr' | 'merge'): string {
  return `git:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
}

function trimPreview(value: string, max = 4000): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...`
}

export interface OutcomeLabels {
  filesChanged: string
  insertions: string
  deletions: string
  topFiles: string
  link: string
}

export function buildOutcomePreview(card: GitOutcomeCard, labels?: OutcomeLabels): string {
  const l = labels || { filesChanged: 'Files changed', insertions: 'Insertions', deletions: 'Deletions', topFiles: 'Top files', link: 'Link' }
  const lines: string[] = [`# ${card.title}`, card.subtitle]
  if (card.summary) {
    lines.push(
      `${l.filesChanged}: ${card.summary.filesChanged}`,
      `${l.insertions}: +${card.summary.insertions}`,
      `${l.deletions}: -${card.summary.deletions}`,
      '', `${l.topFiles}:`,
    )
    for (const file of card.summary.files.slice(0, 8)) {
      lines.push(`- [${file.status}] ${file.path} (+${file.added}/-${file.deleted})`)
    }
  }
  if (card.lines.length > 0) lines.push('', ...card.lines)
  if (card.link) lines.push('', `${l.link}: ${card.link}`)
  return trimPreview(lines.join('\n'))
}

export type GitWorktreeItem = Pick<GitWorktreeInfo, 'path' | 'branch' | 'isCurrent' | 'isMainWorktree' | 'isDetached' | 'isLocked'>

export const EMPTY_BRANCH_META: GitBranchMeta = {
  branch: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  isDetached: false,
}

export const NONE_VALUE = '__none__'

export function pickBaseBranch(branches: GitBranchItem[]): string {
  const names = branches.map(item => item.name)
  if (names.includes('main')) return 'main'
  if (names.includes('master')) return 'master'
  return names[0] || ''
}

export type GitWorkflowDataMode = 'full' | 'changes'

interface UseGitWorkflowDataOptions {
  rootPath: string
  currentBranch: string | null
  /** 侧栏/面板可见时加载；Dialog 可继续传 open 作为别名。 */
  enabled?: boolean
  open?: boolean
  /**
   * 外部 git status 修订号（如 useGitStatus.statusRevision）。
   * Agent / 外部改文件后宿主 refresh 了树侧状态时，用它驱动本 hook 再 loadData，
   * 否则 Changes 列表会停在打开面板时的快照。
   */
  refreshToken?: number
  /**
   * full：分支 / worktree / status / numstat 全量（Git 工作流面板）。
   * changes：实时只刷 status + numstat；分支元数据与列表首次/切根再拉，或显式 ensureBranchContext。
   */
  mode?: GitWorkflowDataMode
}

export function useGitWorkflowData({
  rootPath,
  currentBranch,
  enabled,
  open,
  refreshToken = 0,
  mode = 'full',
}: UseGitWorkflowDataOptions) {
  const active = enabled ?? open ?? false
  const [isLoading, setIsLoading] = useState(false)
  const [branchMeta, setBranchMeta] = useState<GitBranchMeta>(EMPTY_BRANCH_META)
  const [branches, setBranches] = useState<GitBranchItem[]>([])
  const [worktrees, setWorktrees] = useState<GitWorktreeItem[]>([])
  const [files, setFiles] = useState<ChangeFile[]>([])
  const branchContextLoadedForRoot = useRef<string | null>(null)
  const loadGenerationRef = useRef(0)
  const inFlightLoadRef = useRef<Promise<void> | null>(null)
  const trailingLoadOptionsRef = useRef<{ includeBranchContext?: boolean } | null>(null)

  const [checkoutBranch, setCheckoutBranch] = useState('')
  const [newBranchBase, setNewBranchBase] = useState('')
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState('')
  const [worktreeBranch, setWorktreeBranch] = useState('')

  const currentBranchName = branchMeta.branch || currentBranch || ''

  const branchNames = useMemo(
    () => branches.map(item => item.name).filter(Boolean),
    [branches],
  )

  const applyBranchContext = useCallback((
    metaRes: Awaited<ReturnType<NonNullable<typeof window.tabtin.git>['getBranchMeta']>> | null | undefined,
    branchRes: Awaited<ReturnType<NonNullable<typeof window.tabtin.git>['listBranches']>> | null | undefined,
    worktreeRes: Awaited<ReturnType<NonNullable<typeof window.tabtin.git>['listWorktrees']>> | null | undefined,
  ) => {
    if (metaRes?.success && metaRes.meta) {
      setBranchMeta(metaRes.meta)
    } else {
      setBranchMeta(EMPTY_BRANCH_META)
    }

    if (branchRes?.success) {
      const localBranches = (branchRes.localBranches || []) as GitBranchItem[]
      setBranches(localBranches)

      const current = localBranches.find(item => item.isCurrent)?.name || currentBranch || ''
      setCheckoutBranch(prev => prev || current)

      const defaultBase = pickBaseBranch(localBranches)
      setNewBranchBase(prev => prev || defaultBase)
      setWorktreeBaseBranch(prev => prev || defaultBase)
    } else {
      setBranches([])
    }

    if (worktreeRes?.success) {
      setWorktrees((worktreeRes.worktrees || []) as GitWorktreeItem[])
    } else {
      setWorktrees([])
    }
  }, [currentBranch])

  const loadBranchContext = useCallback(async () => {
    const git = window.tabtin?.git
    if (!git) return
    const [metaRes, branchRes, worktreeRes] = await Promise.all([
      git.getBranchMeta(rootPath),
      git.listBranches(rootPath),
      git.listWorktrees(rootPath),
    ])
    applyBranchContext(metaRes, branchRes, worktreeRes)
    branchContextLoadedForRoot.current = rootPath
  }, [applyBranchContext, rootPath])

  const runLoadData = useCallback(async (options?: { includeBranchContext?: boolean }) => {
    const git = window.tabtin?.git
    if (!git) return

    const generation = ++loadGenerationRef.current
    const started = performance.now()
    setIsLoading(true)
    try {
      // changes：首屏只刷 status/numstat；分支上下文由 ensureBranchContext / 显式 include 触发
      // full：保持全量
      const includeBranchContext = options?.includeBranchContext ?? (mode === 'full')

      trackGetStatus()
      trackRawDiff()
      trackRawDiff()

      const statusPromise = git.getStatus(rootPath)
      const numstatHeadPromise = git.rawDiff(rootPath, ['HEAD', '--numstat'])
      const numstatUnstagedPromise = git.rawDiff(rootPath, ['--numstat'])

      if (includeBranchContext) {
        const [metaRes, branchRes, worktreeRes, statusRes, numstatHeadRes, numstatUnstagedRes] = await Promise.all([
          git.getBranchMeta(rootPath),
          git.listBranches(rootPath),
          git.listWorktrees(rootPath),
          statusPromise,
          numstatHeadPromise,
          numstatUnstagedPromise,
        ])
        if (generation !== loadGenerationRef.current) return
        applyBranchContext(metaRes, branchRes, worktreeRes)
        branchContextLoadedForRoot.current = rootPath

        if (statusRes?.success && statusRes.entries) {
          const headMap = parseNumstat(numstatHeadRes?.success ? (numstatHeadRes.diff || '') : '')
          const unstagedMap = parseNumstat(numstatUnstagedRes?.success ? (numstatUnstagedRes.diff || '') : '')
          setFiles(buildChangeFiles(statusRes.entries as Record<string, { x: string; y: string }>, headMap, unstagedMap))
        } else {
          setFiles([])
        }
      } else {
        const [statusRes, numstatHeadRes, numstatUnstagedRes] = await Promise.all([
          statusPromise,
          numstatHeadPromise,
          numstatUnstagedPromise,
        ])
        if (generation !== loadGenerationRef.current) return

        if (statusRes?.success && statusRes.entries) {
          const headMap = parseNumstat(numstatHeadRes?.success ? (numstatHeadRes.diff || '') : '')
          const unstagedMap = parseNumstat(numstatUnstagedRes?.success ? (numstatUnstagedRes.diff || '') : '')
          setFiles(buildChangeFiles(statusRes.entries as Record<string, { x: string; y: string }>, headMap, unstagedMap))
        } else {
          setFiles([])
        }
      }

    } finally {
      if (generation === loadGenerationRef.current) {
        setIsLoading(false)
      }
      trackLoadData(performance.now() - started)
    }
  }, [applyBranchContext, mode, rootPath])

  const loadData = useCallback(async (options?: { includeBranchContext?: boolean }) => {
    if (inFlightLoadRef.current) {
      // 合并同窗口请求：保留最新意图，结束后 trailing 再跑一次
      trailingLoadOptionsRef.current = {
        includeBranchContext: Boolean(
          options?.includeBranchContext
          || trailingLoadOptionsRef.current?.includeBranchContext,
        ) || undefined,
      }
      await inFlightLoadRef.current
      return
    }

    const run = (async () => {
      await runLoadData(options)
      while (trailingLoadOptionsRef.current) {
        const trailing = trailingLoadOptionsRef.current
        trailingLoadOptionsRef.current = null
        await runLoadData(trailing)
      }
    })()

    inFlightLoadRef.current = run
    try {
      await run
    } finally {
      if (inFlightLoadRef.current === run) {
        inFlightLoadRef.current = null
      }
    }
  }, [runLoadData])

  useEffect(() => {
    if (!active) return
    void loadData()
  }, [active, loadData, refreshToken])

  const prevRootPathRef = useRef(rootPath)
  useEffect(() => {
    const rootChanged = prevRootPathRef.current !== rootPath
    prevRootPathRef.current = rootPath
    setCheckoutBranch('')
    setNewBranchBase('')
    setWorktreeBaseBranch('')
    setWorktreeBranch('')
    branchContextLoadedForRoot.current = null
    trailingLoadOptionsRef.current = null
    if (rootChanged) {
      // 仅真正切根时作废进行中的结果，避免首挂载把 generation 顶掉首次 loadData
      loadGenerationRef.current += 1
      invalidateDiffContentCache()
    }
  }, [rootPath])

  const groups = useMemo(() => groupChangeFiles(files), [files])

  return {
    isLoading,
    branchMeta,
    branches,
    branchNames,
    worktrees,
    files,
    groups,
    currentBranchName,
    checkoutBranch,
    setCheckoutBranch,
    newBranchBase,
    setNewBranchBase,
    worktreeBaseBranch,
    setWorktreeBaseBranch,
    worktreeBranch,
    setWorktreeBranch,
    loadData,
    ensureBranchContext: loadBranchContext,
  }
}
