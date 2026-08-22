import {
  buildSizes,
  collectLeafIds,
  createSplitId,
  findLeafPath,
  getNodeAtPath,
  normalizeSizes,
  sideToDirection,
  updateNodeAtPath,
  type LayoutNode,
  type SplitSide,
} from '@/utils/split-layout'

export interface TabCodeEditorGroup {
  id: string
  openFiles: string[]
  activeFile: string | null
}

export interface TabCodeEditorWorkspace {
  groupsById: Record<string, TabCodeEditorGroup>
  layout: LayoutNode
  activeGroupId: string
  /** 允许空分组在 normalize 时保留，供只挂了 History 的分屏使用。不持久化。 */
  pinnedGroupIds?: string[]
}

export const ROOT_EDITOR_GROUP_ID = 'editor-root'

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function normalizeGroup(id: string, group: Partial<TabCodeEditorGroup>): TabCodeEditorGroup {
  const openFiles = dedupe(Array.isArray(group.openFiles) ? group.openFiles : [])
  return {
    id,
    openFiles,
    activeFile: group.activeFile && openFiles.includes(group.activeFile)
      ? group.activeFile
      : openFiles.at(-1) ?? null,
  }
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false
  const node = value as {
    type?: unknown
    paneId?: unknown
    id?: unknown
    direction?: unknown
    children?: unknown
    sizes?: unknown
  }
  if (node.type === 'leaf') return typeof node.paneId === 'string'
  return node.type === 'split'
    && typeof node.id === 'string'
    && (node.direction === 'horizontal' || node.direction === 'vertical')
    && Array.isArray(node.children)
    && Array.isArray(node.sizes)
    && node.children.every(isLayoutNode)
}

function pruneLayout(node: LayoutNode, groupIds: Set<string>): LayoutNode | null {
  if (node.type === 'leaf') {
    return groupIds.has(node.paneId) ? node : null
  }

  const childrenWithSizes = node.children
    .map((child, index) => ({
      child: pruneLayout(child, groupIds),
      size: node.sizes[index] ?? 0,
    }))
    .filter((entry): entry is { child: LayoutNode; size: number } => Boolean(entry.child))
  if (childrenWithSizes.length === 0) return null
  if (childrenWithSizes.length === 1) return childrenWithSizes[0].child
  return {
    ...node,
    children: childrenWithSizes.map((entry) => entry.child),
    sizes: normalizeSizes(
      childrenWithSizes.map((entry) => entry.size),
      childrenWithSizes.length,
    ),
  }
}

function insertEditorLeafAtPath(
  node: LayoutNode,
  leafPath: number[],
  newGroupId: string,
  direction: 'horizontal' | 'vertical',
  side: SplitSide,
): LayoutNode {
  const placeBefore = side === 'left' || side === 'top'
  // 即使父 split 同方向，也保留独立的嵌套节点：这样关闭新组时能回到
  // 原节点的比例，而不会把相邻编辑器的既有份额重新均分。
  const targetLeaf = getNodeAtPath(node, leafPath)
  if (targetLeaf?.type !== 'leaf') return node
  const newLeaf: LayoutNode = { type: 'leaf', paneId: newGroupId }
  return updateNodeAtPath(node, leafPath, () => ({
    type: 'split',
    id: createSplitId('editor-split'),
    direction,
    children: placeBefore ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf],
    sizes: buildSizes(2),
  }))
}

export function createEditorWorkspace(): TabCodeEditorWorkspace {
  const rootGroup: TabCodeEditorGroup = {
    id: ROOT_EDITOR_GROUP_ID,
    openFiles: [],
    activeFile: null,
  }
  return {
    groupsById: { [rootGroup.id]: rootGroup },
    layout: { type: 'leaf', paneId: rootGroup.id },
    activeGroupId: rootGroup.id,
    pinnedGroupIds: [],
  }
}

export function normalizeEditorWorkspace(
  raw: Partial<TabCodeEditorWorkspace> & { openFiles?: string[]; activeFile?: string | null },
): TabCodeEditorWorkspace {
  const hasEditorGroups = Boolean(raw.groupsById && Object.keys(raw.groupsById).length > 0)
  const migratedGroups = hasEditorGroups
    ? raw.groupsById!
    : {
        [ROOT_EDITOR_GROUP_ID]: {
          id: ROOT_EDITOR_GROUP_ID,
          openFiles: raw.openFiles ?? [],
          activeFile: raw.activeFile ?? null,
        },
      }
  // 一个文件允许在多个编辑器组同时可见（分栏编辑），
  // 但每个组内由 normalizeGroup 去重。
  const normalizedGroups = Object.fromEntries(
    Object.entries(migratedGroups).map(([id, group]) => [id, normalizeGroup(id, group)]),
  )
  const pinnedGroupIds = [...new Set(
    (Array.isArray(raw.pinnedGroupIds) ? raw.pinnedGroupIds : [])
      .filter((id) => Boolean(id) && Boolean(normalizedGroups[id])),
  )]
  const nonEmptyGroupIds = new Set(
    Object.values(normalizedGroups)
      .filter((group) => group.openFiles.length > 0 || pinnedGroupIds.includes(group.id))
      .map((group) => group.id),
  )
  const layout = isLayoutNode(raw.layout)
    ? pruneLayout(raw.layout, nonEmptyGroupIds)
    : hasEditorGroups
      ? null
      : { type: 'leaf' as const, paneId: ROOT_EDITOR_GROUP_ID }

  if (!layout || nonEmptyGroupIds.size === 0) {
    return createEditorWorkspace()
  }

  const layoutGroupIds = new Set(collectLeafIds(layout))
  const groupsById = Object.fromEntries(
    Object.entries(normalizedGroups).filter(([id]) => layoutGroupIds.has(id)),
  )
  const firstGroupId = collectLeafIds(layout)[0]
  return {
    groupsById,
    layout,
    activeGroupId: raw.activeGroupId && groupsById[raw.activeGroupId]
      ? raw.activeGroupId
      : firstGroupId,
    pinnedGroupIds: pinnedGroupIds.filter((id) => id in groupsById),
  }
}

export function openFileInEditorGroup(
  workspace: TabCodeEditorWorkspace,
  groupId: string,
  filePath: string,
): TabCodeEditorWorkspace {
  const targetId = workspace.groupsById[groupId] ? groupId : workspace.activeGroupId
  const target = workspace.groupsById[targetId]
  if (!target || !filePath) return workspace

  const groupsById = {
    ...workspace.groupsById,
    [targetId]: {
      ...target,
      openFiles: target.openFiles.includes(filePath)
        ? target.openFiles
        : [...target.openFiles, filePath],
      activeFile: filePath,
    },
  }
  return { ...workspace, groupsById, activeGroupId: targetId }
}

export function activateEditorGroupFile(
  workspace: TabCodeEditorWorkspace,
  groupId: string,
  filePath: string,
): TabCodeEditorWorkspace {
  const group = workspace.groupsById[groupId]
  if (!group?.openFiles.includes(filePath)) return workspace
  return {
    ...workspace,
    activeGroupId: groupId,
    groupsById: { ...workspace.groupsById, [groupId]: { ...group, activeFile: filePath } },
  }
}

export function reorderEditorGroupFile(
  workspace: TabCodeEditorWorkspace,
  groupId: string,
  sourceFilePath: string,
  targetFilePath: string,
  position: 'before' | 'after' = 'before',
): TabCodeEditorWorkspace {
  const group = workspace.groupsById[groupId]
  if (
    !group
    || sourceFilePath === targetFilePath
    || !group.openFiles.includes(sourceFilePath)
    || !group.openFiles.includes(targetFilePath)
  ) {
    return workspace
  }
  const openFiles = group.openFiles.filter((path) => path !== sourceFilePath)
  const targetIndex = openFiles.indexOf(targetFilePath)
  openFiles.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceFilePath)
  return {
    ...workspace,
    groupsById: { ...workspace.groupsById, [groupId]: { ...group, openFiles } },
  }
}

export function closeEditorGroupFile(
  workspace: TabCodeEditorWorkspace,
  groupId: string,
  filePath: string,
): TabCodeEditorWorkspace {
  const group = workspace.groupsById[groupId]
  const index = group?.openFiles.indexOf(filePath) ?? -1
  if (!group || index < 0) return workspace

  const openFiles = group.openFiles.filter((path) => path !== filePath)
  const groupsById = {
    ...workspace.groupsById,
    [groupId]: {
      ...group,
      openFiles,
      activeFile: group.activeFile === filePath
        ? openFiles[index] ?? openFiles[index - 1] ?? null
        : group.activeFile,
    },
  }
  return normalizeEditorWorkspace({ ...workspace, groupsById })
}

export function moveEditorFile(
  workspace: TabCodeEditorWorkspace,
  sourceGroupId: string,
  targetGroupId: string,
  filePath: string,
  targetFilePath: string | null = null,
  position: 'before' | 'after' = 'after',
): TabCodeEditorWorkspace {
  if (sourceGroupId === targetGroupId) {
    return activateEditorGroupFile(workspace, targetGroupId, filePath)
  }
  const source = workspace.groupsById[sourceGroupId]
  const target = workspace.groupsById[targetGroupId]
  if (!source?.openFiles.includes(filePath) || !target) return workspace
  const existingTargetIndex = target.openFiles.indexOf(filePath)
  const targetOpenFiles = target.openFiles.filter((path) => path !== filePath)
  if (targetFilePath === filePath && existingTargetIndex >= 0) {
    targetOpenFiles.splice(existingTargetIndex, 0, filePath)
  } else {
    const targetIndex = targetFilePath ? targetOpenFiles.indexOf(targetFilePath) : -1
    targetOpenFiles.splice(
      targetIndex < 0 ? targetOpenFiles.length : targetIndex + (position === 'after' ? 1 : 0),
      0,
      filePath,
    )
  }

  const groupsById = {
    ...workspace.groupsById,
    [sourceGroupId]: normalizeGroup(sourceGroupId, {
      ...source,
      openFiles: source.openFiles.filter((path) => path !== filePath),
    }),
    [targetGroupId]: {
      ...target,
      openFiles: targetOpenFiles,
      activeFile: filePath,
    },
  }
  return normalizeEditorWorkspace({ ...workspace, groupsById, activeGroupId: targetGroupId })
}

export function splitEditorGroupWithFile(
  workspace: TabCodeEditorWorkspace,
  sourceGroupId: string,
  targetGroupId: string,
  filePath: string,
  side: SplitSide,
): TabCodeEditorWorkspace {
  const source = workspace.groupsById[sourceGroupId]
  const targetPath = findLeafPath(workspace.layout, targetGroupId)
  if (!source?.openFiles.includes(filePath) || !targetPath) return workspace

  const newGroupId = createSplitId('editor')
  const groupsById: Record<string, TabCodeEditorGroup> = {
    ...workspace.groupsById,
    [newGroupId]: { id: newGroupId, openFiles: [filePath], activeFile: filePath },
  }
  groupsById[sourceGroupId] = normalizeGroup(sourceGroupId, {
    ...source,
    openFiles: source.openFiles.filter((path) => path !== filePath),
  })
  const layout = insertEditorLeafAtPath(
    workspace.layout,
    targetPath,
    newGroupId,
    sideToDirection(side),
    side,
  )
  return normalizeEditorWorkspace({ ...workspace, groupsById, layout, activeGroupId: newGroupId })
}

export function setEditorLayoutSplitSizes(
  workspace: TabCodeEditorWorkspace,
  path: number[],
  sizes: number[],
): TabCodeEditorWorkspace {
  const layout = updateNodeAtPath(workspace.layout, path, (node) => (
    node.type === 'split'
      ? { ...node, sizes: normalizeSizes(sizes, node.children.length) }
      : node
  ))
  return { ...workspace, layout }
}

export function pinEditorGroup(
  workspace: TabCodeEditorWorkspace,
  groupId: string,
): TabCodeEditorWorkspace {
  if (!workspace.groupsById[groupId]) return workspace
  const pinnedGroupIds = workspace.pinnedGroupIds ?? []
  if (pinnedGroupIds.includes(groupId)) return workspace
  return { ...workspace, pinnedGroupIds: [...pinnedGroupIds, groupId] }
}

export function unpinEditorGroup(
  workspace: TabCodeEditorWorkspace,
  groupId: string,
): TabCodeEditorWorkspace {
  const pinnedGroupIds = (workspace.pinnedGroupIds ?? []).filter((id) => id !== groupId)
  if (pinnedGroupIds.length === (workspace.pinnedGroupIds ?? []).length) {
    return workspace
  }
  return normalizeEditorWorkspace({ ...workspace, pinnedGroupIds })
}

export function splitEmptyEditorGroup(
  workspace: TabCodeEditorWorkspace,
  targetGroupId: string,
  side: SplitSide,
): TabCodeEditorWorkspace {
  const targetPath = findLeafPath(workspace.layout, targetGroupId)
  if (!targetPath || !workspace.groupsById[targetGroupId]) return workspace

  const newGroupId = createSplitId('editor')
  const groupsById: Record<string, TabCodeEditorGroup> = {
    ...workspace.groupsById,
    [newGroupId]: { id: newGroupId, openFiles: [], activeFile: null },
  }
  const layout = insertEditorLeafAtPath(
    workspace.layout,
    targetPath,
    newGroupId,
    sideToDirection(side),
    side,
  )
  const pinnedGroupIds = [...new Set([...(workspace.pinnedGroupIds ?? []), newGroupId])]
  return {
    ...workspace,
    groupsById,
    layout,
    activeGroupId: newGroupId,
    pinnedGroupIds,
  }
}
