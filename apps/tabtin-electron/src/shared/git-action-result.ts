/**
 * Shared result contract for Git actions.
 *
 * `error` remains part of the public shape for older renderer callers. New
 * callers should prefer `code` for localization and `detail` for diagnostics.
 */
export type GitErrorCode =
  | 'WORKING_TREE_DIRTY'
  | 'WORKING_TREE_UNKNOWN'
  | 'WORKTREE_REMOVE_BLOCKED'
  | 'MAIN_WORKTREE'
  | 'WORKTREE_LOCKED'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_IN_USE'
  | 'RUNTIME_UNAVAILABLE'
  | 'BINDING_CLEANUP_FAILED'
  | 'DETACHED_HEAD'
  | 'NO_COMMITS_TO_PUSH'
  | 'REMOTE_MISSING'
  | 'REMOTE_URL_MISSING'
  | 'CLI_MISSING'
  | 'TARGET_BRANCH_NOT_CHECKED_OUT'
  | 'GIT_BUSY'
  | 'MERGE_CONFLICT'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'INVALID_PATH'
  | 'INVALID_BRANCH_NAME'
  | 'BRANCH_REQUIRED'
  | 'WORKTREE_PATH_REQUIRED'
  | 'SOURCE_WORKTREE_REQUIRED'
  | 'TARGET_BRANCH_REQUIRED'
  | 'SAME_SOURCE_AND_TARGET'
  | 'HEAD_MISSING'
  | 'ALREADY_EXISTS'
  | 'NETWORK_FAILED'
  | 'UPSTREAM_MISSING'
  | 'BEHIND_UPSTREAM'
  | 'PUSH_REJECTED'
  | 'PROVIDER_UNSUPPORTED'
  | 'PR_URL_MISSING'
  | 'BASE_BRANCH_MISSING'
  | 'HEAD_BRANCH_MISSING'
  | 'INVALID_REPOSITORY'
  | 'GENERIC';

export interface GitActionWarning {
  code?: GitErrorCode;
  error?: string;
  detail?: string;
}

export interface GitActionFailure {
  success: false;
  code?: GitErrorCode;
  error?: string;
  detail?: string;
}

export interface GitActionSuccess {
  success: true;
  warnings?: GitActionWarning[];
}

export type GitActionResult = GitActionFailure | GitActionSuccess;
