import type { GitStatusMap } from '../components/TabCodeFileTree'
import type { DiffMode } from '../components/TabCodeDiffView'
import type { ViewMode } from '../components/TabCodeToolbar'
import { normalizeGitTreeFilterPath } from './gitFilteredTree'

interface ResolveVisibleSelectedFileInput {
  selectedFile: string | null
  viewMode: ViewMode
  stagedStatus: GitStatusMap
  unstagedStatus: GitStatusMap
}

function hasGitStatusPath(status: GitStatusMap, selectedFile: string): boolean {
  const selectedKey = normalizeGitTreeFilterPath(selectedFile)
  for (const path of status.keys()) {
    if (normalizeGitTreeFilterPath(path) === selectedKey) return true
  }
  return false
}

export function resolveVisibleSelectedFileForViewMode({
  selectedFile,
  viewMode,
  stagedStatus,
  unstagedStatus,
}: ResolveVisibleSelectedFileInput): string | null {
  if (!selectedFile) return null
  if (viewMode === 'staged') return hasGitStatusPath(stagedStatus, selectedFile) ? selectedFile : null
  if (viewMode === 'unstaged') return hasGitStatusPath(unstagedStatus, selectedFile) ? selectedFile : null
  if (viewMode === 'changes') {
    return hasGitStatusPath(unstagedStatus, selectedFile) || hasGitStatusPath(stagedStatus, selectedFile)
      ? selectedFile
      : null
  }
  return selectedFile
}

export function resolveGitDiffModeForViewMode({
  selectedFile,
  viewMode,
  stagedStatus,
  unstagedStatus,
}: ResolveVisibleSelectedFileInput): DiffMode | undefined {
  if (!selectedFile) return undefined
  if (viewMode === 'unstaged') return 'unstaged'
  if (viewMode === 'staged') return 'staged'
  if (viewMode === 'changes') {
    if (hasGitStatusPath(unstagedStatus, selectedFile)) return 'unstaged'
    if (hasGitStatusPath(stagedStatus, selectedFile)) return 'staged'
  }
  return undefined
}
