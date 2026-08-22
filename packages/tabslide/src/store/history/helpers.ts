import type { Slide } from '../../types/slides'

export const MAX_HISTORY = 50

export const DEBOUNCE_MS = 300

/**
 * 撤销/重做栈总内存上限（字节），防止大文稿长时间编辑导致 OOM。
 * 100MB — undoStack + redoStack 共享此预算。
 */
export const MAX_MEMORY_BYTES = 100 * 1024 * 1024

/**
 * 粗略估算 Slide[] 快照的内存占用（字节）。
 * 使用 JSON.stringify 长度 × 2（UTF-16）作为近似值，
 * 对于含 base64 图片的页面会偏小，但足够作为安全阈值。
 */
export function estimateSnapshotBytes(snapshot: Slide[]): number {
  try {
    return JSON.stringify(snapshot).length * 2
  } catch {
    return 10 * 1024 * 1024
  }
}

/**
 * 对栈从最旧端丢弃，直到栈总体积 <= budget 字节。
 * 返回裁剪后的栈副本。
 */
export function trimStackByMemory(stack: Slide[][], budget: number): Slide[][] {
  let total = 0
  const sizes = stack.map((s) => estimateSnapshotBytes(s))
  for (const sz of sizes) total += sz

  if (total <= budget) return stack

  let trimFrom = 0
  while (trimFrom < stack.length && total > budget) {
    total -= sizes[trimFrom]!
    trimFrom++
  }
  return stack.slice(trimFrom)
}
