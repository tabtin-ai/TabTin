/**
 * 按 rootPath 共享的本地 Git 状态调度：
 * - 一套 fullStatus in-flight + trailing coalesce
 * - 一套递归 watcher + 30s 轮询
 * - 多组件 useGitStatus 只订阅同一份快照
 */

import type { GitFileStatus, GitStatusMap } from '../components/TabCodeFileTree'
import type { GitBranchMeta, GitDiffStatResult, GitFullStatusResult, GitStatusEntry } from '@shared/git-types'
import { isConflictEntry } from '../components/git-workflow/useGitWorkflowData'
import { trackFullStatus, trackStatusRevision } from '../../context-space/code-workspace/changesPerfMetrics'

export interface DiffStat {
  files: number
  insertions: number
  deletions: number
}

export interface LocalGitStatusSnapshot {
  gitStatus: GitStatusMap
  stagedStatus: GitStatusMap
  unstagedStatus: GitStatusMap
  branch: string | null
  branchMeta: GitBranchMeta
  diffStat: DiffStat | null
  isGitRepo: boolean
  isLoading: boolean
  statusRevision: number
  /** 相对路径 → 内容版本；仅当该文件状态指纹变化时递增 */
  contentRevisions: Record<string, number>
}

const EMPTY_BRANCH_META: GitBranchMeta = {
  branch: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  isDetached: false,
}

const EMPTY_SNAPSHOT: LocalGitStatusSnapshot = {
  gitStatus: new Map(),
  stagedStatus: new Map(),
  unstagedStatus: new Map(),
  branch: null,
  branchMeta: EMPTY_BRANCH_META,
  diffStat: null,
  isGitRepo: false,
  isLoading: false,
  statusRevision: 0,
  contentRevisions: {},
}

const EMPTY_ASSUME_REPO_SNAPSHOT: LocalGitStatusSnapshot = {
  ...EMPTY_SNAPSHOT,
  isGitRepo: true,
}

type Listener = () => void

interface RootBucket {
  rootPath: string
  refCount: number
  assumeRepoVotes: number
  snapshot: LocalGitStatusSnapshot
  prevFingerprints: Map<string, string>
  listeners: Set<Listener>
  inFlight: Promise<void> | null
  trailing: boolean
  /** watch 事件里提到的相对/绝对路径；状态码未变时也要抬 contentRevision */
  pendingContentBumpPaths: Set<string>
  /** 手动 refresh / 轮询：对仍 dirty 的路径一律抬版本（内容可能已变） */
  bumpAllDirtyContent: boolean
  /** 合并同一短时间窗口内的重复手动刷新，避免无意义重读全部 Diff。 */
  lastContentBumpAt: number
  pollTimer: ReturnType<typeof setInterval> | null
  watchId: string | null
  unsubWatch: (() => void) | null
  visibilityHandler: (() => void) | null
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const buckets = new Map<string, RootBucket>()
let contentRevisionSequence = 0

function emptyMaps(): Pick<LocalGitStatusSnapshot, 'gitStatus' | 'stagedStatus' | 'unstagedStatus'> {
  return {
    gitStatus: new Map(),
    stagedStatus: new Map(),
    unstagedStatus: new Map(),
  }
}

function notify(bucket: RootBucket): void {
  for (const listener of bucket.listeners) listener()
}

function fingerprintEntry(entry: GitStatusEntry): string {
  return `${entry?.x ?? ' '}${entry?.y ?? ' '}`
}

function toRelPath(rootPath: string, maybePath: string): string {
  const root = rootPath.replace(/\/+$/, '')
  const normalized = maybePath.replace(/\\/g, '/')
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return normalized.replace(/^\.\//, '')
}

function shouldBumpContent(
  bucket: RootBucket,
  relPath: string,
  fingerprintChanged: boolean,
): boolean {
  if (fingerprintChanged) return true
  if (bucket.bumpAllDirtyContent) return true
  if (bucket.pendingContentBumpPaths.has(relPath)) return true
  // 事件可能带绝对路径
  for (const pending of bucket.pendingContentBumpPaths) {
    if (toRelPath(bucket.rootPath, pending) === relPath) return true
  }
  return false
}

function restorePendingContentBumps(
  bucket: RootBucket,
  pendingBumps: Set<string>,
  bumpAllDirty: boolean,
): void {
  for (const path of pendingBumps) {
    bucket.pendingContentBumpPaths.add(path)
  }
  bucket.bumpAllDirtyContent = bucket.bumpAllDirtyContent || bumpAllDirty
}

async function runFetch(bucket: RootBucket): Promise<void> {
  const { rootPath } = bucket
  const git = window.tabtin?.git
  const pendingBumps = new Set(bucket.pendingContentBumpPaths)
  const bumpAllDirty = bucket.bumpAllDirtyContent
  bucket.pendingContentBumpPaths.clear()
  bucket.bumpAllDirtyContent = false

  if (!git) {
    restorePendingContentBumps(bucket, pendingBumps, bumpAllDirty)
    bucket.snapshot = {
      ...EMPTY_SNAPSHOT,
      isGitRepo: false,
      statusRevision: bucket.snapshot.statusRevision + 1,
      contentRevisions: {},
    }
    bucket.prevFingerprints.clear()
    trackStatusRevision(bucket.snapshot.statusRevision)
    notify(bucket)
    return
  }

  bucket.snapshot = { ...bucket.snapshot, isLoading: true }
  notify(bucket)
  trackFullStatus()

  try {
    const result = (await git.fullStatus(rootPath)) as GitFullStatusResult
    if (!result?.success || !result.isRepo) {
      restorePendingContentBumps(bucket, pendingBumps, bumpAllDirty)
      const nextRevision = bucket.snapshot.statusRevision + 1
      bucket.snapshot = {
        ...EMPTY_SNAPSHOT,
        isGitRepo: false,
        isLoading: false,
        statusRevision: nextRevision,
        contentRevisions: {},
      }
      bucket.prevFingerprints.clear()
      trackStatusRevision(nextRevision)
      notify(bucket)
      return
    }

    const maps = emptyMaps()
    const entries = (result.status?.entries ?? {}) as Record<string, GitStatusEntry>
    const nextFingerprints = new Map<string, string>()
    const nextContentRevisions = { ...bucket.snapshot.contentRevisions }
    let fetchContentRevision: number | null = null

    // 合并 fullStatus 等待期间新到达的 watch 意图，不能被本轮快照覆盖。
    // 这些事件对应的内容可能已经包含在当前结果里，因此直接纳入本轮 bump。
    restorePendingContentBumps(bucket, pendingBumps, bumpAllDirty)

    const isWorktreeChanged = (y: string) => y !== ' '
    const isIndexChanged = (x: string, y: string) => x !== ' ' && !(x === '?' && y === '?')

    for (const [relPath, entry] of Object.entries(entries)) {
      const absPath = rootPath.endsWith('/')
        ? `${rootPath}${relPath}`
        : `${rootPath}/${relPath}`
      const x = entry?.x ?? ' '
      const y = entry?.y ?? ' '
      const displayStatus = (y !== ' ' ? y : x) as GitFileStatus
      maps.gitStatus.set(absPath, displayStatus)

      if (!isConflictEntry(x, y)) {
        if (isIndexChanged(x, y)) maps.stagedStatus.set(absPath, displayStatus)
        if (isWorktreeChanged(y) || (x === '?' && y === '?')) {
          maps.unstagedStatus.set(absPath, displayStatus)
        }
      }

      const fp = fingerprintEntry(entry)
      nextFingerprints.set(relPath, fp)
      const fingerprintChanged = bucket.prevFingerprints.get(relPath) !== fp
      if (shouldBumpContent(bucket, relPath, fingerprintChanged)) {
        if (fetchContentRevision === null) {
          contentRevisionSequence += 1
          fetchContentRevision = contentRevisionSequence
        }
        nextContentRevisions[relPath] = fetchContentRevision
      }
    }

    bucket.pendingContentBumpPaths.clear()
    bucket.bumpAllDirtyContent = false

    // 已消失的文件清理版本键，避免无限增长
    for (const key of Object.keys(nextContentRevisions)) {
      if (!nextFingerprints.has(key)) delete nextContentRevisions[key]
    }

    const nextRevision = bucket.snapshot.statusRevision + 1
    const stat: GitDiffStatResult | undefined = result.diffStat
    bucket.prevFingerprints = nextFingerprints
    bucket.snapshot = {
      gitStatus: maps.gitStatus,
      stagedStatus: maps.stagedStatus,
      unstagedStatus: maps.unstagedStatus,
      branch: result.branch || null,
      branchMeta: result.branchMeta || EMPTY_BRANCH_META,
      diffStat: stat
        ? {
            files: stat.total.changed,
            insertions: stat.total.added,
            deletions: stat.total.deleted,
          }
        : null,
      isGitRepo: true,
      isLoading: false,
      statusRevision: nextRevision,
      contentRevisions: nextContentRevisions,
    }
    trackStatusRevision(nextRevision)
    notify(bucket)
  } catch (err) {
    restorePendingContentBumps(bucket, pendingBumps, bumpAllDirty)
    console.warn('[TabCode] Git 状态查询失败:', err)
    bucket.snapshot = {
      ...bucket.snapshot,
      isGitRepo: false,
      isLoading: false,
    }
    notify(bucket)
  }
}

function scheduleFetch(bucket: RootBucket, options?: { bumpAllDirtyContent?: boolean }): void {
  if (options?.bumpAllDirtyContent) {
    const now = Date.now()
    if (now - bucket.lastContentBumpAt >= 300) {
      bucket.bumpAllDirtyContent = true
      bucket.lastContentBumpAt = now
    }
  }
  if (bucket.inFlight) {
    bucket.trailing = true
    return
  }

  bucket.inFlight = runFetch(bucket).finally(() => {
    bucket.inFlight = null
    if (bucket.trailing) {
      bucket.trailing = false
      scheduleFetch(bucket)
    }
  })
}

function scheduleDebouncedFetch(bucket: RootBucket, delayMs = 200): void {
  if (bucket.debounceTimer) clearTimeout(bucket.debounceTimer)
  bucket.debounceTimer = setTimeout(() => {
    bucket.debounceTimer = null
    scheduleFetch(bucket)
  }, delayMs)
}

function startWatch(bucket: RootBucket): void {
  if (bucket.watchId || bucket.unsubWatch) return
  const fileSystem = window.tabtin?.fileSystem
  if (!fileSystem?.watch || !fileSystem?.unwatch || !fileSystem?.onWatchEvent) return

  let cancelled = false
  let eventUnsub: (() => void) | null = null
  bucket.unsubWatch = () => {
    cancelled = true
    eventUnsub?.()
    eventUnsub = null
  }

  void fileSystem
    .watch(bucket.rootPath, { recursive: true })
    .then((result) => {
      if (!result?.success || !result.watchId) return
      if (cancelled) {
        // 订阅已解除：立刻卸掉刚拿到的 watch，避免泄漏
        void fileSystem.unwatch(result.watchId)
        return
      }
      bucket.watchId = result.watchId
      eventUnsub = fileSystem.onWatchEvent((payload) => {
        if (payload.watchId !== bucket.watchId) return
        const fullPath = typeof payload.fullPath === 'string' ? payload.fullPath : ''
        if (fullPath) {
          bucket.pendingContentBumpPaths.add(toRelPath(bucket.rootPath, fullPath))
        } else {
          // 溢出/全局事件拿不到具体路径：抬所有 dirty，避免 Diff 停在旧内容
          bucket.bumpAllDirtyContent = true
        }
        scheduleDebouncedFetch(bucket, 200)
      })
    })
    .catch(() => {
      /* fail-soft：轮询仍会兜底 */
    })
}

function stopWatch(bucket: RootBucket): void {
  const fileSystem = window.tabtin?.fileSystem
  const watchId = bucket.watchId
  bucket.unsubWatch?.()
  bucket.unsubWatch = null
  bucket.watchId = null
  if (watchId && fileSystem?.unwatch) {
    void fileSystem.unwatch(watchId)
  }
}

function startPolling(bucket: RootBucket): void {
  if (bucket.pollTimer) return
  const tick = () => {
    if (document.hidden) return
    // 轮询只靠状态指纹抬版本；内容同状态再改依赖 watch 路径 bump
    scheduleFetch(bucket)
  }
  bucket.pollTimer = setInterval(tick, 30_000)
  const onVisibility = () => {
    if (!document.hidden) scheduleFetch(bucket, { bumpAllDirtyContent: true })
  }
  bucket.visibilityHandler = onVisibility
  document.addEventListener('visibilitychange', onVisibility)
}

function stopPolling(bucket: RootBucket): void {
  if (bucket.pollTimer) {
    clearInterval(bucket.pollTimer)
    bucket.pollTimer = null
  }
  if (bucket.visibilityHandler) {
    document.removeEventListener('visibilitychange', bucket.visibilityHandler)
    bucket.visibilityHandler = null
  }
}

function ensureBucket(rootPath: string): RootBucket {
  let bucket = buckets.get(rootPath)
  if (!bucket) {
    bucket = {
      rootPath,
      refCount: 0,
      assumeRepoVotes: 0,
      snapshot: { ...EMPTY_SNAPSHOT },
      prevFingerprints: new Map(),
      listeners: new Set(),
      inFlight: null,
      trailing: false,
      pendingContentBumpPaths: new Set(),
      bumpAllDirtyContent: false,
      lastContentBumpAt: Number.NEGATIVE_INFINITY,
      pollTimer: null,
      watchId: null,
      unsubWatch: null,
      visibilityHandler: null,
      debounceTimer: null,
    }
    buckets.set(rootPath, bucket)
  }
  return bucket
}

export function subscribeLocalGitStatus(
  rootPath: string | null,
  listener: Listener,
  options: { assumeRepo?: boolean } = {},
): () => void {
  if (!rootPath) {
    return () => undefined
  }

  const bucket = ensureBucket(rootPath)
  bucket.refCount += 1
  if (options.assumeRepo) bucket.assumeRepoVotes += 1
  if (bucket.assumeRepoVotes > 0 && bucket.snapshot.statusRevision === 0 && !bucket.snapshot.isGitRepo) {
    bucket.snapshot = { ...bucket.snapshot, isGitRepo: true }
  }
  bucket.listeners.add(listener)

  if (bucket.refCount === 1) {
    startWatch(bucket)
    startPolling(bucket)
    scheduleFetch(bucket)
  }

  return () => {
    bucket.listeners.delete(listener)
    bucket.refCount -= 1
    if (options.assumeRepo) bucket.assumeRepoVotes = Math.max(0, bucket.assumeRepoVotes - 1)
    if (bucket.refCount <= 0) {
      if (bucket.debounceTimer) clearTimeout(bucket.debounceTimer)
      stopWatch(bucket)
      stopPolling(bucket)
      buckets.delete(rootPath)
    }
  }
}

export function getLocalGitStatusSnapshot(
  rootPath: string | null,
  options: { assumeRepo?: boolean } = {},
): LocalGitStatusSnapshot {
  if (!rootPath) {
    return options.assumeRepo ? EMPTY_ASSUME_REPO_SNAPSHOT : EMPTY_SNAPSHOT
  }
  const bucket = buckets.get(rootPath)
  if (!bucket) {
    return options.assumeRepo ? EMPTY_ASSUME_REPO_SNAPSHOT : EMPTY_SNAPSHOT
  }
  return bucket.snapshot
}

export function refreshLocalGitStatus(rootPath: string | null): void {
  if (!rootPath) return
  const bucket = buckets.get(rootPath)
  if (!bucket) return
  scheduleFetch(bucket, { bumpAllDirtyContent: true })
}

/** 测试辅助：清空共享桶 */
export function __resetLocalGitStatusSharedForTests(): void {
  for (const bucket of buckets.values()) {
    if (bucket.debounceTimer) clearTimeout(bucket.debounceTimer)
    stopWatch(bucket)
    stopPolling(bucket)
  }
  buckets.clear()
  contentRevisionSequence = 0
}
