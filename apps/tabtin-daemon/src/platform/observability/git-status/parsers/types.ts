import type {
  GitFileEntry as SharedGitFileEntry,
  RemoteGitStatus,
} from '@tabtin/app-shell/types';

export type GitFileEntry = SharedGitFileEntry;
export type GitStatusData = RemoteGitStatus;

export interface GitBranchInfo {
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export function emptyGitStatus(repoPath: string): GitStatusData {
  return {
    is_repo: false,
    repo_path: repoPath,
    branch: null,
    upstream_branch: null,
    ahead_count: 0,
    behind_count: 0,
    is_dirty: false,
    modified_count: 0,
    staged_count: 0,
    untracked_count: 0,
    deleted_count: 0,
    conflict_count: 0,
    stash_count: 0,
    staged_lines_added: 0,
    staged_lines_removed: 0,
    unstaged_lines_added: 0,
    unstaged_lines_removed: 0,
    files: [],
    total_file_count: 0,
    collected_at: new Date().toISOString(),
  };
}
