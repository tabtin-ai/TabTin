type TranslateOptions = Record<string, unknown> & { defaultValue?: string }
type Translate = (key: string, options?: TranslateOptions) => string

function readErrorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const code = typeof record.code === 'string' ? record.code : ''
    const detail = typeof record.detail === 'string' ? record.detail : ''
    const message = typeof record.message === 'string' ? record.message : ''
    const rawError = typeof record.error === 'string' ? record.error : ''
    return [code, detail, rawError, message].filter(Boolean).join('\n')
  }
  return ''
}

function normalizeErrorText(error: unknown): string {
  return readErrorText(error).replace(/\r\n/g, '\n').trim()
}

function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' ? code : ''
}

const GIT_ERROR_CODE_KEYS: Record<string, string> = {
  WORKING_TREE_DIRTY: 'workingTreeDirty',
  WORKING_TREE_UNKNOWN: 'workingTreeUnknown',
  WORKTREE_REMOVE_BLOCKED: 'worktreeRemoveBlocked',
  MAIN_WORKTREE: 'mainWorktree',
  WORKTREE_LOCKED: 'worktreeLocked',
  WORKTREE_NOT_FOUND: 'worktreeNotFound',
  WORKTREE_IN_USE: 'worktreeInUse',
  RUNTIME_UNAVAILABLE: 'runtimeUnavailable',
  BINDING_CLEANUP_FAILED: 'bindingCleanupFailed',
  DETACHED_HEAD: 'detachedHead',
  NO_COMMITS_TO_PUSH: 'noCommitsToPush',
  REMOTE_MISSING: 'remoteMissing',
  REMOTE_URL_MISSING: 'remoteUrlMissing',
  CLI_MISSING: 'cliMissing',
  TARGET_BRANCH_NOT_CHECKED_OUT: 'targetBranchNotCheckedOut',
  GIT_BUSY: 'gitBusy',
  MERGE_CONFLICT: 'mergeConflict',
  AUTH_FAILED: 'authFailed',
  PERMISSION_DENIED: 'permissionDenied',
  INVALID_PATH: 'invalidPath',
  INVALID_BRANCH_NAME: 'invalidBranchName',
  BRANCH_REQUIRED: 'branchRequired',
  WORKTREE_PATH_REQUIRED: 'worktreePathRequired',
  SOURCE_WORKTREE_REQUIRED: 'sourceWorktreeRequired',
  TARGET_BRANCH_REQUIRED: 'targetBranchRequired',
  SAME_SOURCE_AND_TARGET: 'sameSourceAndTarget',
  HEAD_MISSING: 'headMissing',
  ALREADY_EXISTS: 'alreadyExists',
  NETWORK_FAILED: 'networkFailed',
  UPSTREAM_MISSING: 'upstreamMissing',
  BEHIND_UPSTREAM: 'behindUpstream',
  PUSH_REJECTED: 'pushRejected',
  PROVIDER_UNSUPPORTED: 'providerUnsupported',
  PR_URL_MISSING: 'prUrlMissing',
  BASE_BRANCH_MISSING: 'baseBranchMissing',
  HEAD_BRANCH_MISSING: 'headBranchMissing',
  INVALID_REPOSITORY: 'invalidRepository',
  GENERIC: 'generic',
}

function firstMatch(raw: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    const value = match?.find((item, index) => index > 0 && Boolean(item))
    if (value) return value
  }
  return ''
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle))
}

function gitError(key: string, t: Translate, options?: TranslateOptions): string {
  return t(`gitFlow.gitErrors.${key}`, options)
}

/** 标记文案已本地化，避免二次 format 时被当成 raw stderr 吞掉。 */
const LOCALIZED_GIT_ERROR_PREFIX = '__localized__:'

export function asLocalizedGitError(message: string): string {
  if (!message) return message
  if (message.startsWith(LOCALIZED_GIT_ERROR_PREFIX)) return message
  return `${LOCALIZED_GIT_ERROR_PREFIX}${message}`
}

export function formatGitErrorForToast(error: unknown, t: Translate): string {
  const codeKey = GIT_ERROR_CODE_KEYS[readErrorCode(error)]
  if (codeKey) return gitError(codeKey, t, { defaultValue: t('gitFlow.unknownError') })
  const raw = normalizeErrorText(error)
  if (!raw) return t('gitFlow.unknownError')
  if (raw.startsWith(LOCALIZED_GIT_ERROR_PREFIX)) {
    return raw.slice(LOCALIZED_GIT_ERROR_PREFIX.length)
  }

  const lower = raw.toLowerCase()
  const lockPath = firstMatch(raw, [
    /unable to create ['"]([^'"]+\.lock)['"]/i,
    /['"]([^'"]+\.lock)['"]/i,
  ])

  if (
    (lower.includes('unable to create') && lower.includes('.lock') && lower.includes('file exists'))
    || lower.includes('index.lock')
    || lower.includes('another git process')
    || raw.includes('Git 正在执行中')
  ) {
    return gitError('gitBusy', t, { path: lockPath || t('gitFlow.gitErrors.lockFile') })
  }

  if (includesAny(lower, [
    'working tree has uncommitted changes',
    'source worktree has uncommitted changes',
    'target worktree has uncommitted changes',
    'local changes would be overwritten',
    'please commit your changes or stash them',
    'contains modified or untracked files',
    'use --force to delete it',
  ])) {
    return gitError('workingTreeDirty', t)
  }

  if (includesAny(lower, ["could not resolve 'head'", 'needed a single revision'])) {
    return gitError('headMissing', t)
  }

  if (includesAny(lower, ['file paths are invalid', 'invalid file path'])) {
    return gitError('invalidPath', t)
  }

  if (includesAny(lower, ['invalid working directory', 'not a git repository', 'current branch not found'])) {
    return gitError('invalidRepository', t)
  }

  if (includesAny(lower, [
    'invalid branch name',
    'invalid startpoint',
    'contains disallowed characters',
    'is not a valid branch name',
    'is not a commit and a branch',
  ])) {
    return gitError('invalidBranchName', t)
  }

  if (includesAny(lower, ['branch is required', 'branch name is required'])) {
    return gitError('branchRequired', t)
  }

  if (lower.includes('worktree path is required')) {
    return gitError('worktreePathRequired', t)
  }

  if (includesAny(lower, ['sourceworktreepath is required', 'source worktree not found'])) {
    return gitError('sourceWorktreeRequired', t)
  }

  if (lower.includes('targetbranch is required')) {
    return gitError('targetBranchRequired', t)
  }

  if (includesAny(lower, [
    'authentication failed',
    'permission denied (publickey)',
    'could not read username',
    'repository not found',
    '403',
    '401',
  ])) {
    return gitError('authFailed', t)
  }

  if (includesAny(lower, [
    'path is not accessible',
    'outside allowed directories',
    'access denied',
    'permission denied',
    'operation not permitted',
    'eacces',
    'eperm',
    'fs_permission_denied',
  ])) {
    return gitError('permissionDenied', t)
  }

  if (includesAny(lower, ['source and target worktree cannot be the same', 'source branch and target branch are the same'])) {
    return gitError('sameSourceAndTarget', t)
  }

  if (includesAny(lower, ['detached head cannot pull', 'source worktree is detached head'])) {
    return gitError('detachedHead', t)
  }

  if (includesAny(lower, ['merge conflict detected', 'automatic merge failed', 'fix conflicts and then commit'])) {
    return gitError('mergeConflict', t)
  }

  if (includesAny(lower, [
    'a branch named',
    'already exists',
    'is already checked out',
    'is already used by worktree',
    'already a worktree',
    'already exists and is not an empty directory',
  ])) {
    const branch = firstMatch(raw, [
      /branch named ['"]([^'"]+)['"] already exists/i,
      /['"]([^'"]+)['"] is already checked out/i,
      /['"]([^'"]+)['"] is already used by worktree/i,
    ])
    return gitError('alreadyExists', t, { name: branch || t('gitFlow.gitErrors.target') })
  }

  if (includesAny(lower, ['could not resolve host', 'failed to connect', 'network is unreachable', 'unable to access'])) {
    return gitError('networkFailed', t)
  }

  if (includesAny(lower, ['has no upstream branch', 'no upstream configured'])) {
    return gitError('upstreamMissing', t)
  }

  if (includesAny(lower, ['failed to push some refs', 'non-fast-forward', 'fetch first'])) {
    return gitError('pushRejected', t)
  }

  if (lower.includes('no commits between') || raw.includes('没有提交差异')) {
    return gitError('noPrDiff', t)
  }

  if (
    lower.includes('base ref must be a branch')
    || lower.includes("base sha can't be blank")
    || raw.includes('目标分支')
  ) {
    return gitError('baseBranchMissing', t)
  }

  if (lower.includes("head sha can't be blank") || raw.includes('源分支')) {
    return gitError('headBranchMissing', t)
  }

  if (includesAny(lower, ['provider not supported', 'current repo is not supported'])) {
    return gitError('providerUnsupported', t)
  }

  if (includesAny(lower, ['url not captured', 'mr created but url not captured'])) {
    return gitError('prUrlMissing', t)
  }

  if (includesAny(lower, ['gh: command not found', 'glab: command not found', 'spawn gh enoent', 'spawn glab enoent'])) {
    return gitError('cliMissing', t)
  }

  return gitError('generic', t, { defaultValue: t('gitFlow.unknownError') })
}

export function formatGitWarningForToast(warning: unknown, t: Translate): string {
  const codeKey = GIT_ERROR_CODE_KEYS[readErrorCode(warning)]
  if (codeKey) return gitError(codeKey, t, { defaultValue: t('gitFlow.unknownError') })
  const raw = normalizeErrorText(warning)
  const lower = raw.toLowerCase()
  if (lower.startsWith('remove worktree failed:')) {
    return gitError('removeWorktreeWarning', t, {
      reason: formatGitErrorForToast(raw.slice('remove worktree failed:'.length), t),
    })
  }
  if (lower.startsWith('delete source branch failed:')) {
    return gitError('deleteSourceBranchWarning', t, {
      reason: formatGitErrorForToast(raw.slice('delete source branch failed:'.length), t),
    })
  }
  return formatGitErrorForToast(raw, t)
}
