import fs from 'node:fs'
import path from 'node:path'

type PathOperations = Pick<typeof path, 'basename' | 'join'>

const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function sanitizePathSegment(value: string, fallback: string, maxLength: number): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
  const safe = (normalized || fallback).slice(0, maxLength).replace(/[. ]+$/g, '') || fallback
  return WINDOWS_RESERVED_SEGMENT.test(safe) ? `_${safe}` : safe
}

export function buildManagedAgentWorktreeBasePath(
  input: {
    managedRoot: string
    repositoryRoot: string
    branch: string
  },
  pathOperations: PathOperations = path,
): string {
  const repository = sanitizePathSegment(
    pathOperations.basename(input.repositoryRoot),
    'repository',
    64,
  )
  const branch = sanitizePathSegment(input.branch, 'branch', 80)
  return pathOperations.join(input.managedRoot, repository, `wt-${branch}`)
}

export function chooseAvailableAgentWorktreePath(
  basePath: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  if (!exists(basePath)) return basePath
  let suffix = 2
  while (exists(`${basePath}-${suffix}`)) suffix += 1
  return `${basePath}-${suffix}`
}
