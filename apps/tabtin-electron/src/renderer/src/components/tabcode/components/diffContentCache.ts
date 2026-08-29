/**
 * Diff 左右内容加载缓存：同 root/path/mode/version 去重并发请求，
 * 并以有限并发队列避免首屏同时打爆 Git/磁盘。
 */

import { trackRawDiff, trackReadPreview, trackShowFile } from '../../context-space/code-workspace/changesPerfMetrics'
import { relativePath } from '../utils/path'
import { createLogger } from '@/utils/logger'

export type DiffMode = 'head' | 'staged' | 'unstaged' | 'commit' | 'branch'
export type DiffContentRevision = string | number

export interface DiffSideContents {
  left: string
  right: string
  metadataChange?: DiffMetadata
}

export interface DiffMetadata {
  oldMode: string | null
  newMode: string | null
}

type CacheEntry = {
  value?: DiffSideContents
  promise?: Promise<DiffSideContents>
  at: number
}

const cache = new Map<string, CacheEntry>()
const MAX_ENTRIES = 80
/** 同时进行的 Diff 内容加载上限（每个再并发左右两侧） */
export const DIFF_CONTENT_MAX_CONCURRENCY = 2

interface PreviewResult {
  success?: boolean
  data?: { content?: string }
  error?: string
}

let inflight = 0
const waitQueue: Array<{ resolve: () => void; priority: boolean }> = []
const log = createLogger('DiffContentCache')

function acquireSlot(priority = false): Promise<void> {
  if (inflight < DIFF_CONTENT_MAX_CONCURRENCY) {
    inflight += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const item = {
      resolve: () => {
        inflight += 1
        resolve()
      },
      priority,
    }
    if (priority) {
      const firstNormal = waitQueue.findIndex((queued) => !queued.priority)
      if (firstNormal === -1) waitQueue.push(item)
      else waitQueue.splice(firstNormal, 0, item)
    } else {
      waitQueue.push(item)
    }
  })
}

function releaseSlot(): void {
  inflight = Math.max(0, inflight - 1)
  const next = waitQueue.shift()
  if (next) next.resolve()
}

function cacheKey(
  rootPath: string,
  filePath: string,
  diffMode: DiffMode,
  commitHash: string | undefined,
  baseCommitHash: string | undefined,
  contentRevision: DiffContentRevision,
): string {
  return [
    rootPath,
    filePath,
    diffMode,
    commitHash || '',
    baseCommitHash || '',
    String(contentRevision),
  ].join('\0')
}

function trimCache(): void {
  if (cache.size <= MAX_ENTRIES) return
  const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)
  const overflow = cache.size - MAX_ENTRIES
  for (let i = 0; i < overflow; i += 1) {
    cache.delete(entries[i][0])
  }
}

export function parseGitDiffMetadata(raw: string): DiffMetadata | undefined {
  const modeChange = raw.match(/mode change (\d+) => (\d+)/)
  if (modeChange) {
    return { oldMode: modeChange[1], newMode: modeChange[2] }
  }
  const oldMode = raw.match(/old mode (\d+)/)?.[1] ?? null
  const newMode = raw.match(/new mode (\d+)/)?.[1] ?? null
  const createMode = raw.match(/(?:new file|create) mode (\d+)/)?.[1] ?? null
  const deleteMode = raw.match(/(?:deleted file|delete) mode (\d+)/)?.[1] ?? null

  if (oldMode || newMode) return { oldMode, newMode }
  if (createMode) return { oldMode: null, newMode: createMode }
  if (deleteMode) return { oldMode: deleteMode, newMode: null }
  return undefined
}

async function loadSides(
  rootPath: string,
  filePath: string,
  diffMode: DiffMode,
  commitHash?: string,
  baseCommitHash?: string,
): Promise<DiffSideContents> {
  const filePathInRepo = relativePath(rootPath, filePath)
  const git = window.tabtin.git
  const fs = window.tabtin.fileSystem

  const getHead = () => {
    trackShowFile()
    return git.getFileAtHead(rootPath, filePathInRepo).then(r => r?.content ?? '').catch(() => '')
  }
  const getStaged = () => {
    trackShowFile()
    return git.getFileAtStaged(rootPath, filePathInRepo).then(r => r?.content ?? '').catch(() => '')
  }
  const getWorktree = () => {
    trackReadPreview()
    return fs.readFilePreview(filePath, { maxBytes: 512 * 1024 }).then((r: PreviewResult) => {
      if (r?.success === false) {
        const message = r.error || 'failed to read worktree file'
        if (/ENOENT|not found|no such file/i.test(message)) return ''
        throw new Error(message)
      }
      return r?.data?.content || ''
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (/ENOENT|not found|no such file/i.test(message)) return ''
      throw error
    })
  }
  const getAtCommit = (hash: string | undefined, parent?: boolean) => {
    if (!hash || !git.getFileAtCommit) {
      return Promise.reject(new Error(
        !hash
          ? 'missing commit hash'
          : 'git getFileAtCommit unavailable; restart the client',
      ))
    }
    trackShowFile()
    return git.getFileAtCommit(rootPath, {
      filePath: filePathInRepo,
      commitHash: hash,
      parent,
    }).then((result) => {
      if (result?.success === false && result.reason === 'too_large') {
        throw new Error(result.error || 'file content exceeds preview limit')
      }
      return result?.content ?? ''
    })
  }

  let leftPromise: Promise<string>
  let rightPromise: Promise<string>

  switch (diffMode) {
    case 'staged':
      leftPromise = getHead()
      rightPromise = getStaged()
      break
    case 'unstaged':
      leftPromise = getStaged()
      rightPromise = getWorktree()
      break
    case 'commit':
      leftPromise = getAtCommit(commitHash, true)
      rightPromise = getAtCommit(commitHash, false)
      break
    case 'branch':
      leftPromise = getAtCommit(baseCommitHash)
      rightPromise = getAtCommit(commitHash)
      break
    case 'head':
    default:
      leftPromise = getHead()
      rightPromise = getWorktree()
      break
  }

  const metadataPromise = diffMode !== 'commit' && diffMode !== 'branch' && typeof git.rawDiff === 'function'
    ? (() => {
        const diffArgs = diffMode === 'staged'
          ? ['--cached', '--', filePathInRepo]
          : diffMode === 'unstaged'
            ? ['--', filePathInRepo]
            : ['HEAD', '--', filePathInRepo]
        trackRawDiff()
        return git.rawDiff(rootPath, diffArgs)
          .then(result => result?.success ? parseGitDiffMetadata(result.diff || '') : undefined)
          .catch(error => {
            log.warn('diff metadata unavailable', {
              filePath: filePathInRepo,
              error: String(error),
            })
            return undefined
          })
      })()
    : Promise.resolve(undefined)
  const [left, right, metadataChange] = await Promise.all([
    leftPromise,
    rightPromise,
    metadataPromise,
  ])
  return metadataChange ? { left, right, metadataChange } : { left, right }
}

export function loadDiffContents(params: {
  rootPath: string
  filePath: string
  diffMode: DiffMode
  commitHash?: string
  baseCommitHash?: string
  contentRevision: DiffContentRevision
  priority?: boolean
}): Promise<DiffSideContents> {
  const key = cacheKey(
    params.rootPath,
    params.filePath,
    params.diffMode,
    params.commitHash,
    params.baseCommitHash,
    params.contentRevision,
  )
  const hit = cache.get(key)
  if (hit?.value) {
    hit.at = Date.now()
    return Promise.resolve(hit.value)
  }
  if (hit?.promise) {
    hit.at = Date.now()
    return hit.promise
  }

  const promise = (async () => {
    await acquireSlot(params.priority)
    try {
      const value = await loadSides(
        params.rootPath,
        params.filePath,
        params.diffMode,
        params.commitHash,
        params.baseCommitHash,
      )
      cache.set(key, { value, at: Date.now() })
      trimCache()
      return value
    } catch (err) {
      cache.delete(key)
      throw err
    } finally {
      releaseSlot()
    }
  })()

  cache.set(key, { promise, at: Date.now() })
  return promise
}

export function invalidateDiffContentCache(rootPath?: string): void {
  if (!rootPath) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${rootPath}\0`)) cache.delete(key)
  }
}

export function __resetDiffContentCacheForTests(): void {
  cache.clear()
  inflight = 0
  waitQueue.length = 0
}

/** 测试辅助：当前排队等待的加载数 */
export function __getDiffContentQueueDepthForTests(): number {
  return waitQueue.length
}

/** 测试辅助：当前占用的并发槽 */
export function __getDiffContentInflightForTests(): number {
  return inflight
}
