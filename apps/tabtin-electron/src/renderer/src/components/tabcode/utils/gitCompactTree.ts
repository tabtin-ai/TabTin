import { basename, relativePath } from './path'

export interface GitChangeEntry {
  path: string
  status: string | null
}

export type CompactGitChangeTreeNode =
  | {
    type: 'directory'
    id: string
    name: string
    children: CompactGitChangeTreeNode[]
  }
  | {
    type: 'file'
    id: string
    path: string
    name: string
    status: string | null
  }

export type CompactGitChangeTreeRow = CompactGitChangeTreeNode & { depth: number }

interface MutableDirectoryNode {
  type: 'directory'
  id: string
  name: string
  children: MutableGitChangeTreeNode[]
  childDirs: Map<string, MutableDirectoryNode>
}

type MutableGitChangeTreeNode =
  | MutableDirectoryNode
  | {
    type: 'file'
    id: string
    path: string
    name: string
    status: string | null
  }

function createDirectory(id: string, name: string): MutableDirectoryNode {
  return { type: 'directory', id, name, children: [], childDirs: new Map() }
}

function sortNodes(nodes: CompactGitChangeTreeNode[]): CompactGitChangeTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function compactNode(node: MutableGitChangeTreeNode): CompactGitChangeTreeNode {
  if (node.type === 'file') return node

  let current = node
  const names = [current.name]
  while (current.children.length === 1 && current.children[0].type === 'directory') {
    current = current.children[0]
    names.push(current.name)
  }

  return {
    type: 'directory',
    id: current.id,
    name: names.join('/'),
    children: sortNodes(current.children.map(compactNode)),
  }
}

export function buildCompactGitChangeTree(
  rootPath: string,
  entries: Iterable<GitChangeEntry>,
): CompactGitChangeTreeNode[] {
  const root = createDirectory('', '')

  for (const entry of entries) {
    const rel = relativePath(rootPath, entry.path).replace(/\\/g, '/')
    const parts = rel.split('/').filter(Boolean)
    const fileName = parts.pop() || basename(entry.path)
    let dir = root

    parts.forEach((part, index) => {
      const id = parts.slice(0, index + 1).join('/')
      let childDir = dir.childDirs.get(part)
      if (!childDir) {
        childDir = createDirectory(id, part)
        dir.childDirs.set(part, childDir)
        dir.children.push(childDir)
      }
      dir = childDir
    })

    dir.children.push({
      type: 'file',
      id: entry.path,
      path: entry.path,
      name: fileName,
      status: entry.status,
    })
  }

  return sortNodes(root.children.map(compactNode))
}

export function flattenCompactGitChangeTree(
  nodes: CompactGitChangeTreeNode[],
  collapsedDirectoryIds: ReadonlySet<string>,
): CompactGitChangeTreeRow[] {
  const rows: CompactGitChangeTreeRow[] = []
  const visit = (node: CompactGitChangeTreeNode, depth: number) => {
    rows.push({ ...node, depth })
    if (node.type === 'directory' && !collapsedDirectoryIds.has(node.id)) {
      node.children.forEach(child => visit(child, depth + 1))
    }
  }
  nodes.forEach(node => visit(node, 0))
  return rows
}
