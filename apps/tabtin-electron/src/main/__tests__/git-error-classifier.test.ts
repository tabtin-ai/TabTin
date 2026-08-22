import { describe, expect, it } from 'vitest';
import {
  classifyGitErrorCode,
  classifyGitFailure,
} from '../git-error-classifier';

describe('git error classifier', () => {
  it('classifies worktree removal dirty errors separately from ordinary checkout dirtiness', () => {
    expect(
      classifyGitErrorCode(
        "fatal: '/tmp/demo-wt' contains modified or untracked files, use --force to delete it",
      ),
    ).toBe('WORKTREE_REMOVE_BLOCKED');
  });

  it('classifies policy and Git errors with stable codes', () => {
    expect(
      classifyGitErrorCode('detached HEAD cannot be pushed directly'),
    ).toBe('DETACHED_HEAD');
    expect(classifyGitErrorCode('no commits to push (ahead = 0)')).toBe(
      'NO_COMMITS_TO_PUSH',
    );
    expect(
      classifyGitErrorCode(
        "target branch 'main' is not checked out in any worktree",
      ),
    ).toBe('TARGET_BRANCH_NOT_CHECKED_OUT');
    expect(
      classifyGitErrorCode(
        'branch is behind upstream by 2 commit(s), please pull/rebase first',
      ),
    ).toBe('BEHIND_UPSTREAM');
    expect(
      classifyGitErrorCode("The current branch has no upstream branch"),
    ).toBe('UPSTREAM_MISSING');
    expect(
      classifyGitErrorCode(
        'GitHub CLI (gh) not found, please install and login first',
      ),
    ).toBe('CLI_MISSING');
  });

  it('keeps a backward-compatible error string and redacts repository paths in detail', () => {
    const result = classifyGitFailure({
      message: 'working tree has uncommitted changes',
      cwd: '/Users/example/project',
    });
    expect(result).toMatchObject({
      success: false,
      code: 'WORKING_TREE_DIRTY',
      error: 'working tree has uncommitted changes',
      detail: 'working tree has uncommitted changes',
    });
  });
});
