import type { ChangeSectionId } from './useGitWorkflowData'

export type ScmSelectionKey = `${ChangeSectionId}:${string}`

export interface ScmSelectionState {
  selectedKeys: ReadonlySet<ScmSelectionKey>
  anchorKey: ScmSelectionKey | null
}

export function makeScmSelectionKey(section: ChangeSectionId, path: string): ScmSelectionKey {
  return `${section}:${path}`
}

export function parseScmSelectionKey(key: ScmSelectionKey): { section: ChangeSectionId; path: string } {
  const idx = key.indexOf(':')
  return {
    section: key.slice(0, idx) as ChangeSectionId,
    path: key.slice(idx + 1),
  }
}

export function emptyScmSelection(): ScmSelectionState {
  return { selectedKeys: new Set(), anchorKey: null }
}

export function reduceSelection(args: {
  prev: ScmSelectionState
  mode: 'replace' | 'toggle' | 'range'
  section: ChangeSectionId
  path: string
  /** Ordered paths currently visible in this section */
  sectionPaths: readonly string[]
}): ScmSelectionState {
  const { prev, mode, section, path, sectionPaths } = args
  const key = makeScmSelectionKey(section, path)

  if (mode === 'replace') {
    return { selectedKeys: new Set([key]), anchorKey: key }
  }

  if (mode === 'toggle') {
    const next = new Set(prev.selectedKeys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return { selectedKeys: next, anchorKey: key }
  }

  // range: same-section contiguous from anchor to path
  const anchor = prev.anchorKey
  if (!anchor || parseScmSelectionKey(anchor).section !== section) {
    return { selectedKeys: new Set([key]), anchorKey: key }
  }

  const anchorPath = parseScmSelectionKey(anchor).path
  const start = sectionPaths.indexOf(anchorPath)
  const end = sectionPaths.indexOf(path)
  if (start < 0 || end < 0) {
    return { selectedKeys: new Set([key]), anchorKey: key }
  }

  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  const next = new Set<ScmSelectionKey>()
  for (let i = lo; i <= hi; i += 1) {
    const p = sectionPaths[i]
    if (p) next.add(makeScmSelectionKey(section, p))
  }
  // Keep anchor so further Shift+clicks extend from the original click
  return { selectedKeys: next, anchorKey: anchor }
}

/** Keep keys that still exist in the partitioned file lists. */
export function pruneSelection(
  prev: ScmSelectionState,
  validKeys: ReadonlySet<ScmSelectionKey>,
): ScmSelectionState {
  const next = new Set<ScmSelectionKey>()
  for (const key of prev.selectedKeys) {
    if (validKeys.has(key)) next.add(key)
  }
  const anchorKey = prev.anchorKey && validKeys.has(prev.anchorKey) ? prev.anchorKey : null
  return { selectedKeys: next, anchorKey }
}

/**
 * Paths to act on when clicking stage/unstage/discard on a row.
 * If the clicked row is selected and the same section has multiple selected → batch;
 * otherwise → only the clicked path.
 * When `sectionPaths` is provided, batch order follows the visible list.
 */
export function resolveActionPaths(
  selectedKeys: ReadonlySet<ScmSelectionKey>,
  section: ChangeSectionId,
  clickedPath: string,
  sectionPaths?: readonly string[],
): string[] {
  const clickedKey = makeScmSelectionKey(section, clickedPath)
  if (!selectedKeys.has(clickedKey)) return [clickedPath]

  const selectedInSection = new Set<string>()
  for (const key of selectedKeys) {
    const parsed = parseScmSelectionKey(key)
    if (parsed.section === section) selectedInSection.add(parsed.path)
  }
  if (selectedInSection.size <= 1) return [clickedPath]

  if (sectionPaths) {
    return sectionPaths.filter(path => selectedInSection.has(path))
  }
  return [...selectedInSection]
}

export function selectionModeFromEvent(event: {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}): 'replace' | 'toggle' | 'range' {
  if (event.shiftKey) return 'range'
  if (event.metaKey || event.ctrlKey) return 'toggle'
  return 'replace'
}
