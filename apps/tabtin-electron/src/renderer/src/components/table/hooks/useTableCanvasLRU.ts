import { useEffect, useMemo, useRef } from 'react'

/**
 * Soft-Unload Level 1: LRU queue for table canvas lifecycle.
 *
 * When more than MAX_ACTIVE_CANVASES tables are open, the least-recently-accessed
 * non-active tabs are marked for unloading. Their Canvas/React component tree is
 * unmounted to free GPU textures and memory (~3-10 MB/tab), while the Store and
 * Y.Doc connection remain intact. Re-opening an unloaded tab triggers a soft-reload
 * from existing Store data.
 */

const MAX_ACTIVE_CANVASES = 5

const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>())

export function useTableCanvasLRU(
  openTableIds: string[],
  activeTableId: string | null,
): ReadonlySet<string> {
  const lastAccessRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (activeTableId) {
      lastAccessRef.current.set(activeTableId, Date.now())
    }
  }, [activeTableId])

  useEffect(() => {
    const map = lastAccessRef.current
    const now = Date.now()
    const openSet = new Set(openTableIds)

    for (let i = 0; i < openTableIds.length; i++) {
      const id = openTableIds[i]
      if (!map.has(id)) {
        map.set(id, now - (openTableIds.length - i))
      }
    }

    for (const id of map.keys()) {
      if (!openSet.has(id)) map.delete(id)
    }
  }, [openTableIds])

  return useMemo(() => {
    if (openTableIds.length <= MAX_ACTIVE_CANVASES) return EMPTY_SET

    const map = lastAccessRef.current
    const hasActive = activeTableId != null && openTableIds.includes(activeTableId)

    const candidates = openTableIds.filter(id => id !== activeTableId)
    candidates.sort((a, b) => (map.get(b) ?? 0) - (map.get(a) ?? 0))

    const keepSlots = MAX_ACTIVE_CANVASES - (hasActive ? 1 : 0)
    const toUnload = candidates.slice(keepSlots)

    return toUnload.length > 0 ? new Set(toUnload) : EMPTY_SET
  }, [openTableIds, activeTableId])
}

/**
 * Stable-reference helper: returns a `Set<string>` that only changes identity
 * when the membership actually differs from the previous render.
 */
export function useStableUnloadedSet(raw: ReadonlySet<string>): ReadonlySet<string> {
  const prevRef = useRef<ReadonlySet<string>>(EMPTY_SET)

  return useMemo(() => {
    const prev = prevRef.current
    if (raw.size === 0 && prev.size === 0) return EMPTY_SET
    if (raw.size === prev.size) {
      let same = true
      for (const id of raw) {
        if (!prev.has(id)) { same = false; break }
      }
      if (same) return prev
    }
    prevRef.current = raw
    return raw
  }, [raw])
}
