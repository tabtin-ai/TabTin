export type LayerDropPlacement = 'before' | 'after'

export interface LayerRange {
  start: number
  end: number
}

interface ComputeLayerDropToIndexArgs {
  drag: LayerRange
  target: LayerRange
  placement: LayerDropPlacement
  totalCount: number
  /** 实际被拖拽的元素数量（非连续组时与 end-start+1 不同） */
  dragMemberCount?: number
  /** 非连续组成员的实际索引集合，用于精准 overlap 判断 */
  dragMemberIndices?: Set<number>
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function computeLayerDropToIndex({
  drag,
  target,
  placement,
  totalCount,
  dragMemberCount,
  dragMemberIndices,
}: ComputeLayerDropToIndexArgs): number | null {
  if (totalCount <= 0) return null

  const dragStart = Math.min(drag.start, drag.end)
  const dragEnd = Math.max(drag.start, drag.end)
  const targetStart = Math.min(target.start, target.end)
  const targetEnd = Math.max(target.start, target.end)
  if (dragStart < 0 || dragEnd >= totalCount || targetStart < 0 || targetEnd >= totalCount) return null

  const hasOverlap = dragMemberIndices
    ? rangeOverlapsSet(targetStart, targetEnd, dragMemberIndices)
    : !(dragEnd < targetStart || dragStart > targetEnd)
  if (hasOverlap) return null

  const blockSize = dragMemberCount ?? (dragEnd - dragStart + 1)
  const sourceBeforeTarget = dragEnd < targetStart

  let shift: number
  if (dragMemberIndices && sourceBeforeTarget) {
    shift = countBelow(dragMemberIndices, targetStart)
  } else {
    shift = sourceBeforeTarget ? blockSize : 0
  }

  const targetStartInRemaining = targetStart - shift
  const targetEndInRemaining = targetEnd - shift

  const rawInsertAt = placement === 'before'
    ? targetEndInRemaining + 1
    : targetStartInRemaining
  const maxInsertAt = Math.max(0, totalCount - blockSize)
  const insertAt = clamp(rawInsertAt, 0, maxInsertAt)

  if (dragMemberIndices) {
    const spanSize = dragEnd - dragStart + 1
    if (spanSize !== blockSize) {
      // Non-contiguous: compressing scattered members into a contiguous block
      // always produces a different array, so it's never a no-op.
      return insertAt
    }
    const shift = countBelow(dragMemberIndices, dragStart)
    const equivInsert = dragStart - shift
    return insertAt === equivInsert ? null : insertAt
  }

  return insertAt === dragStart ? null : insertAt
}

function rangeOverlapsSet(start: number, end: number, set: Set<number>): boolean {
  for (let i = start; i <= end; i++) {
    if (set.has(i)) return true
  }
  return false
}

function countBelow(set: Set<number>, threshold: number): number {
  let n = 0
  for (const v of set) if (v < threshold) n++
  return n
}

