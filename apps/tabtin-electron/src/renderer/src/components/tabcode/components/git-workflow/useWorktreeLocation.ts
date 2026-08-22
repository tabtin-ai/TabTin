import { useEffect, useMemo, useState } from 'react'
import {
  joinParentAndName,
  sanitizeWorktreeFolderName,
  splitParentAndName,
  suggestSiblingWorktreePath,
  normalizePathForCompare,
} from '../../utils/worktreePaths'

export interface UseWorktreeLocationParams {
  repoRoot: string
  branch: string
  existingPaths?: string[]
  /** 变化时清空用户改过的位置（例如对话框重新打开）。 */
  resetKey?: unknown
}

export function useWorktreeLocation(params: UseWorktreeLocationParams) {
  const suggestedPath = useMemo(
    () =>
      suggestSiblingWorktreePath({
        repoRoot: params.repoRoot,
        branch: params.branch,
        existingPaths: params.existingPaths,
      }),
    [params.repoRoot, params.branch, params.existingPaths],
  )
  const suggested = useMemo(
    () => splitParentAndName(suggestedPath),
    [suggestedPath],
  )

  const [customParent, setCustomParent] = useState<string | null>(null)
  const [customName, setCustomName] = useState<string | null>(null)
  const [locationOpen, setLocationOpen] = useState(false)

  useEffect(() => {
    setCustomParent(null)
    setCustomName(null)
    setLocationOpen(false)
  }, [params.resetKey])

  const parent = customParent ?? suggested.parent
  const folderName = customName ?? suggested.name
  const fullPath = joinParentAndName(parent, folderName)

  return {
    parent,
    folderName,
    fullPath,
    locationOpen,
    setLocationOpen,
    followsSuggestion: customParent === null && customName === null,
    setFolderName: (name: string) => {
      setCustomName(sanitizeWorktreeFolderName(name))
    },
    setParent: (next: string) => {
      setCustomParent(normalizePathForCompare(next))
    },
  }
}
