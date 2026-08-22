/**
 * Changes 页面级 Diff 搜索：基于静态 Diff 行文本建索引并匹配。
 * 不依赖视口挂载状态；索引构建复用 diffContentCache 有限并发队列。
 */

import { createLogger } from '@/utils/logger'
import { loadDiffContents } from '@components/tabcode/components/diffContentCache'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import { joinRootPath } from './changesViewModel'
import {
  buildStaticUnifiedDiffViewModel,
  getSearchableStaticDiffRows,
} from './staticUnifiedDiffModel'

const log = createLogger('ChangesPageSearch')

export interface ChangesSearchHit {
  path: string
  rowId: string
  text: string
  oldLine: number | null
  newLine: number | null
  kind: 'add' | 'remove' | 'context'
}

export type ChangesSearchIndexStatus =
  | 'idle'
  | 'indexing'
  | 'ready'
  | 'empty-query'

export interface ChangesSearchIndexResult {
  status: ChangesSearchIndexStatus
  hits: ChangesSearchHit[]
  indexedFileCount: number
  skippedFileCount: number
  errorFileCount: number
  generation: number
}

export interface BuildChangesSearchIndexParams {
  rootPath: string
  files: ChangeFile[]
  contentRevisions: Record<string, number>
  query: string
  generation: number
  signal?: { cancelled: boolean }
  onProgress?: (indexed: number, total: number) => void
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function matchStaticDiffRows(
  path: string,
  rows: ReturnType<typeof getSearchableStaticDiffRows>,
  normalizedQuery: string,
): ChangesSearchHit[] {
  if (!normalizedQuery) return []
  const hits: ChangesSearchHit[] = []
  for (const row of rows) {
    if (row.kind === 'gap') continue
    if (!row.text.toLowerCase().includes(normalizedQuery)) continue
    hits.push({
      path,
      rowId: row.id,
      text: row.text,
      oldLine: row.oldLine,
      newLine: row.newLine,
      kind: row.kind,
    })
  }
  return hits
}

/**
 * 为全部未提交文件建立搜索命中列表。
 * 文件顺序与传入 files 一致；同一文件内按行模型顺序。
 */
export async function buildChangesSearchIndex(
  params: BuildChangesSearchIndexParams,
): Promise<ChangesSearchIndexResult> {
  const normalizedQuery = normalizeQuery(params.query)
  if (!normalizedQuery) {
    return {
      status: 'empty-query',
      hits: [],
      indexedFileCount: 0,
      skippedFileCount: 0,
      errorFileCount: 0,
      generation: params.generation,
    }
  }

  const hits: ChangesSearchHit[] = []
  let indexedFileCount = 0
  let skippedFileCount = 0
  let errorFileCount = 0
  const total = params.files.length

  for (let index = 0; index < params.files.length; index += 1) {
    if (params.signal?.cancelled) {
      return {
        status: 'indexing',
        hits,
        indexedFileCount,
        skippedFileCount,
        errorFileCount,
        generation: params.generation,
      }
    }

    const file = params.files[index]
    const contentRevision = params.contentRevisions[file.path]
    if (typeof contentRevision !== 'number') {
      skippedFileCount += 1
      params.onProgress?.(index + 1, total)
      continue
    }

    try {
      const absolutePath = joinRootPath(params.rootPath, file.path)
      const { left, right } = await loadDiffContents({
        rootPath: params.rootPath,
        filePath: absolutePath,
        diffMode: 'head',
        contentRevision,
        priority: false,
      })
      if (params.signal?.cancelled) {
        return {
          status: 'indexing',
          hits,
          indexedFileCount,
          skippedFileCount,
          errorFileCount,
          generation: params.generation,
        }
      }
      const model = buildStaticUnifiedDiffViewModel(left, right, {
        filePath: file.path,
      })
      if (!model.hasChanges) {
        skippedFileCount += 1
      } else {
        indexedFileCount += 1
        hits.push(
          ...matchStaticDiffRows(
            file.path,
            getSearchableStaticDiffRows(model),
            normalizedQuery,
          ),
        )
      }
    } catch (error) {
      errorFileCount += 1
      log.warn('index file failed', {
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    params.onProgress?.(index + 1, total)
  }

  return {
    status: 'ready',
    hits,
    indexedFileCount,
    skippedFileCount,
    errorFileCount,
    generation: params.generation,
  }
}

export function stepSearchHitIndex(
  current: number,
  total: number,
  direction: 1 | -1,
): number {
  if (total <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : total - 1
  return (current + direction + total) % total
}
