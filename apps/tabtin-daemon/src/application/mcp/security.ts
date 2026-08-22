import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { checkDaemonPathAccess } from '../security/path-access.js'

const FILE_ACTIONS = new Set(['write_file', 'edit_file', 'delete_file'])
const SEARCH_ACTIONS = new Set(['glob_search', 'grep_search'])

export class McpSecurityPolicy {
  constructor(private readonly options: {
    workspaceRoot?: string
    getWorkspaceSnapshot?: () => import('@tabtin/security-policy').WorkspaceSnapshot | null
  }) {}

  enforce(toolName: string, args: Record<string, unknown>): Record<string, unknown> | null {
    const pathSet = this.collectPaths(toolName, args)
    if (!pathSet) return null
    const fallbackRoots = [this.options.workspaceRoot, getHomeTabtinPath()].filter((path): path is string => !!path)
    const snapshot = this.options.getWorkspaceSnapshot?.() ?? null
    for (const path of pathSet.paths) {
      const access = checkDaemonPathAccess(path, pathSet.action, { snapshot, fallbackRoots })
      if (!access.allowed) return {
        content: [{ type: 'text', text: `Blocked by security policy: ${access.reason?.message ?? 'path not allowed'}` }],
        isError: true,
      }
    }
    return null
  }

  private collectPaths(toolName: string, args: Record<string, unknown>): { paths: string[]; action: 'read' | 'write' } | null {
    if (FILE_ACTIONS.has(toolName) || toolName === 'read_file') {
      const path = String(args.file_path ?? args.path ?? '')
      return path ? { paths: [path], action: toolName === 'read_file' ? 'read' : 'write' } : null
    }
    if (SEARCH_ACTIONS.has(toolName)) {
      const paths: string[] = []
      const single = String(args.target_directory ?? args.path ?? '')
      if (single) paths.push(single)
      return paths.length ? { paths, action: 'read' } : null
    }
    if (toolName !== 'read_lints') return null
    const paths = this.stringPaths(args.paths)
    return paths.length ? { paths, action: 'read' } : null
  }

  private stringPaths(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : []
  }
}
