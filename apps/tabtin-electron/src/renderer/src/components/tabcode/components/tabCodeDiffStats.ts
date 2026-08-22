/**
 * TabCode Monaco Diff 行变更统计：空基线（新文件 / 删文件）时
 * 过滤 Monaco 空 model「至少一行」带来的合成增删。
 */

export interface MonacoLineChangeLike {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

export interface DiffLineStats {
  insertions: number
  deletions: number
  hasChanges: boolean
}

/** 精确空串才是「无旧/新内容」基线；单换行属于真实内容，不得特判。 */
export function isEmptyDiffBaseline(content: string | null | undefined): boolean {
  return content === ''
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  let lines = 1
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) lines += 1
  }
  // 尾部换行不额外多算一行（与常见 Diff 行计数一致：`a\n` → 1 行）
  if (content.endsWith('\n')) lines -= 1
  return Math.max(lines, 0)
}

/**
 * 汇总 Monaco getLineChanges()；空 original / 空 modified 时去掉合成空行。
 */
export function summarizeMonacoLineChanges(
  changes: readonly MonacoLineChangeLike[] | null | undefined,
  originalContent: string,
  modifiedContent: string,
): DiffLineStats {
  const emptyOriginal = isEmptyDiffBaseline(originalContent)
  const emptyModified = isEmptyDiffBaseline(modifiedContent)

  if (emptyOriginal && emptyModified) {
    return { insertions: 0, deletions: 0, hasChanges: false }
  }

  // 新文件：Monaco 会把空 original 的唯一空行当成删除
  if (emptyOriginal) {
    const insertions = countLines(modifiedContent)
    return {
      insertions,
      deletions: 0,
      hasChanges: insertions > 0,
    }
  }

  // 删除文件：对称处理空 modified 的合成插入
  if (emptyModified) {
    const deletions = countLines(originalContent)
    return {
      insertions: 0,
      deletions,
      hasChanges: deletions > 0,
    }
  }

  let insertions = 0
  let deletions = 0
  for (const change of changes ?? []) {
    if (change.modifiedEndLineNumber >= change.modifiedStartLineNumber) {
      insertions += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
    }
    if (change.originalEndLineNumber >= change.originalStartLineNumber) {
      deletions += change.originalEndLineNumber - change.originalStartLineNumber + 1
    }
  }

  return {
    insertions,
    deletions,
    hasChanges: (changes?.length ?? 0) > 0 || originalContent !== modifiedContent,
  }
}
