import type { GitActionFailure, GitErrorCode } from '@shared/git-action-result';

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function redactGitDetail(text: string, cwd?: string): string {
  const normalized = normalize(text);
  if (!normalized) return '';
  const withoutCwd = cwd?.trim()
    ? normalized.split(cwd.trim()).join('<repo>')
    : normalized;
  return withoutCwd.replace(
    /(?:access_token|refresh_token|token|password|secret)=[^&\s]+/gi,
    '$1=<redacted>',
  );
}

export function classifyGitErrorCode(message: string): GitErrorCode {
  const lower = message.toLowerCase();

  if (
    lower.includes('contains modified or untracked files') ||
    lower.includes('use --force to delete it')
  )
    return 'WORKTREE_REMOVE_BLOCKED';
  if (lower.includes('is a main working tree')) return 'MAIN_WORKTREE';
  if (lower.includes('worktree') && lower.includes('locked'))
    return 'WORKTREE_LOCKED';
  if (lower.includes('working tree has uncommitted changes'))
    return 'WORKING_TREE_DIRTY';
  if (
    lower.includes("could not resolve 'head'") ||
    lower.includes('needed a single revision')
  )
    return 'HEAD_MISSING';
  if (lower.includes('detached head')) return 'DETACHED_HEAD';
  if (lower.includes('no commits to push')) return 'NO_COMMITS_TO_PUSH';
  if (lower.includes('remote not found')) return 'REMOTE_MISSING';
  if (lower.includes('remote url not found')) return 'REMOTE_URL_MISSING';
  if (lower.includes('cli') && lower.includes('not found'))
    return 'CLI_MISSING';
  if (lower.includes('not checked out in any worktree'))
    return 'TARGET_BRANCH_NOT_CHECKED_OUT';
  if (
    lower.includes('merge conflict') ||
    lower.includes('automatic merge failed')
  )
    return 'MERGE_CONFLICT';
  if (lower.includes('index.lock') || lower.includes('another git process'))
    return 'GIT_BUSY';
  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied (publickey)') ||
    lower.includes(' 401') ||
    lower.includes(' 403')
  )
    return 'AUTH_FAILED';
  if (lower.includes('permission denied') || lower.includes('access denied'))
    return 'PERMISSION_DENIED';
  if (lower.includes('outside your workspace') || lower.includes('blocked by'))
    return 'PERMISSION_DENIED';
  if (
    lower.includes('invalid file path') ||
    lower.includes('file paths are invalid')
  )
    return 'INVALID_PATH';
  if (
    lower.includes('invalid working directory') ||
    lower.includes('not a git repository')
  )
    return 'INVALID_REPOSITORY';
  if (
    lower.includes('invalid branch name') ||
    lower.includes('disallowed characters')
  )
    return 'INVALID_BRANCH_NAME';
  if (lower.includes('branch is required')) return 'BRANCH_REQUIRED';
  if (lower.includes('worktree path is required'))
    return 'WORKTREE_PATH_REQUIRED';
  if (
    lower.includes('sourceworktreepath is required') ||
    lower.includes('source worktree not found')
  )
    return 'SOURCE_WORKTREE_REQUIRED';
  if (lower.includes('targetbranch is required'))
    return 'TARGET_BRANCH_REQUIRED';
  if (
    lower.includes('source and target worktree cannot be the same') ||
    lower.includes('source branch and target branch are the same')
  )
    return 'SAME_SOURCE_AND_TARGET';
  if (
    lower.includes('could not resolve host') ||
    lower.includes('failed to connect') ||
    lower.includes('network is unreachable')
  )
    return 'NETWORK_FAILED';
  if (
    lower.includes('behind upstream') ||
    lower.includes('please pull/rebase first')
  )
    return 'BEHIND_UPSTREAM';
  if (
    lower.includes('has no upstream branch') ||
    lower.includes('no upstream configured')
  )
    return 'UPSTREAM_MISSING';
  if (
    lower.includes('failed to push some refs') ||
    lower.includes('non-fast-forward')
  )
    return 'PUSH_REJECTED';
  if (lower.includes('already exists')) return 'ALREADY_EXISTS';
  return 'GENERIC';
}

export function classifyGitFailure(input: {
  message?: string;
  code?: GitErrorCode;
  detail?: string;
  cwd?: string;
}): GitActionFailure {
  const message = normalize(input.message) || 'Git operation failed';
  return {
    success: false,
    code: input.code ?? classifyGitErrorCode(message),
    error: message,
    ...(input.detail || message
      ? { detail: redactGitDetail(input.detail ?? message, input.cwd) }
      : {}),
  };
}
