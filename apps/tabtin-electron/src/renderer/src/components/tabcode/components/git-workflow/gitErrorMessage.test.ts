import { describe, expect, it } from 'vitest'
import {
  asLocalizedGitError,
  formatGitErrorForToast,
  formatGitWarningForToast,
} from './gitErrorMessage'

type TestOptions = Record<string, unknown> & { defaultValue?: string }

function makeT(messages: Record<string, string>) {
  return (key: string, options?: TestOptions): string => {
    const template = messages[key] ?? options?.defaultValue ?? key
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
  }
}

const zhT = makeT({
  'gitFlow.unknownError': '未知错误，请稍后重试',
  'gitFlow.gitErrors.gitBusy': '暂存区被 Git 索引锁占用。请先等待正在运行的 Git 操作结束；如果确认没有 Git 进程在运行，可删除锁文件后重试。锁文件：{{path}}',
  'gitFlow.gitErrors.lockFile': '仓库 Git 元数据目录中的 index.lock',
  'gitFlow.gitErrors.headMissing': '当前仓库还没有首次提交，无法基于 HEAD 执行该操作。',
  'gitFlow.gitErrors.invalidPath': '文件路径无效，未执行 Git 操作。',
  'gitFlow.gitErrors.workingTreeDirty': '当前工作区还有未提交的变更，请先提交或暂存后再试。',
  'gitFlow.gitErrors.workingTreeUnknown': '无法确认当前工作区是否干净，已阻止操作。',
  'gitFlow.gitErrors.worktreeRemoveBlocked': '这个 Worktree 里还有未提交或未跟踪的文件。',
  'gitFlow.gitErrors.cliMissing': '缺少 GitHub 或 GitLab 命令行工具，请安装并登录后重试。',
  'gitFlow.gitErrors.behindUpstream': '当前分支落后于上游，请先拉取或变基后再推送。',
  'gitFlow.gitErrors.upstreamMissing': '当前分支还没有设置上游分支，请先推送并建立追踪关系。',
  'gitFlow.gitErrors.authFailed': '远端仓库鉴权失败，请检查登录状态、SSH Key 或访问权限。',
  'gitFlow.gitErrors.alreadyExists': '{{name}} 已存在或已被其它 Worktree 使用，请换一个名称或路径。',
  'gitFlow.gitErrors.target': '目标',
  'gitFlow.gitErrors.generic': 'Git 操作失败，请稍后重试。',
  'gitFlow.gitErrors.removeWorktreeWarning': '源 Worktree 删除失败：{{reason}}',
})

const enT = makeT({
  'gitFlow.unknownError': 'Unknown error, please retry',
  'gitFlow.gitErrors.gitBusy': 'The staging area is blocked by a Git index lock. Wait for active Git operations to finish; if no Git process is running, remove the lock file and retry. Lock file: {{path}}',
  'gitFlow.gitErrors.lockFile': 'index.lock in the repository Git metadata directory',
  'gitFlow.gitErrors.generic': 'Git operation failed. Please try again.',
})

describe('formatGitErrorForToast', () => {
  it('localizes git index.lock fatal errors for Chinese UI', () => {
    const raw = [
      "fatal: Unable to create 'C:/workspace/TabTin-feature/TabTin/.git/index.lock': File exists.",
      '',
      'Another git process seems to be running in this repository, e.g.',
      'an editor opened by git commit. Please make sure all processes',
      'are terminated then try again. If it still fails, a git process',
      'may have crashed in this repository earlier:',
      'remove the file manually to continue.',
    ].join('\n')

    const message = formatGitErrorForToast(raw, zhT)

    expect(message).toContain('暂存区被 Git 索引锁占用')
    expect(message).toContain('如果确认没有 Git 进程在运行，可删除锁文件')
    expect(message).toContain('index.lock')
    expect(message).not.toContain('fatal: Unable to create')
    expect(message).not.toContain('Another git process')
  })

  it('uses English text for the same git lock error under English UI', () => {
    const message = formatGitErrorForToast(
      "fatal: Unable to create 'C:/repo/.git/index.lock': File exists.",
      enT,
    )

    expect(message).toContain('The staging area is blocked by a Git index lock')
    expect(message).toContain('if no Git process is running, remove the lock file')
    expect(message).toContain('C:/repo/.git/index.lock')
  })

  it('explains the legacy generic busy error as an index lock conflict', () => {
    const message = formatGitErrorForToast('Git 正在执行中，请稍后重试', zhT)

    expect(message).toContain('暂存区被 Git 索引锁占用')
    expect(message).toContain('如果确认没有 Git 进程在运行，可删除锁文件')
    expect(message).toContain('仓库 Git 元数据目录中的 index.lock')
  })

  it('localizes dirty worktree errors instead of returning raw stderr', () => {
    const message = formatGitErrorForToast(
      'working tree has uncommitted changes, please commit/stash first',
      zhT,
    )

    expect(message).toBe('当前工作区还有未提交的变更，请先提交或暂存后再试。')
  })

  it('localizes native worktree remove dirty errors', () => {
    expect(
      formatGitErrorForToast(
        "fatal: '/tmp/demo-wt' contains modified or untracked files, use --force to delete it",
        zhT,
      ),
    ).toBe('当前工作区还有未提交的变更，请先提交或暂存后再试。')
  })

  it('localizes structured CLI missing and behind-upstream codes', () => {
    expect(
      formatGitErrorForToast(
        {
          code: 'CLI_MISSING',
          error: 'GitHub CLI (gh) not found, please install and login first',
        },
        zhT,
      ),
    ).toBe('缺少 GitHub 或 GitLab 命令行工具，请安装并登录后重试。')
    expect(
      formatGitErrorForToast(
        {
          code: 'BEHIND_UPSTREAM',
          error: 'branch is behind upstream by 2 commit(s), please pull/rebase first',
        },
        zhT,
      ),
    ).toBe('当前分支落后于上游，请先拉取或变基后再推送。')
    expect(
      formatGitErrorForToast(
        { code: 'UPSTREAM_MISSING', error: 'branch is behind upstream by 2 commit(s)' },
        zhT,
      ),
    ).toBe('当前分支还没有设置上游分支，请先推送并建立追踪关系。')
  })

  it('prefers the structured error code over legacy message matching', () => {
    expect(
      formatGitErrorForToast(
        { code: 'WORKING_TREE_UNKNOWN', error: 'some old message' },
        zhT,
      ),
    ).toBe('无法确认当前工作区是否干净，已阻止操作。')
  })

  it('passes through pre-localized checkout-after-stash messages', () => {
    const localized = asLocalizedGitError(
      '变更已暂存到 stash，但分支未能切换：当前工作区还有未提交的变更，请先提交或暂存后再试。',
    )
    expect(formatGitErrorForToast(localized, zhT)).toBe(
      '变更已暂存到 stash，但分支未能切换：当前工作区还有未提交的变更，请先提交或暂存后再试。',
    )
  })

  it('explains missing HEAD in a repository without its first commit', () => {
    const message = formatGitErrorForToast("fatal: could not resolve 'HEAD'", zhT)

    expect(message).toBe('当前仓库还没有首次提交，无法基于 HEAD 执行该操作。')
  })

  it('explains rejected unsafe file paths', () => {
    const message = formatGitErrorForToast('one or more file paths are invalid', zhT)

    expect(message).toBe('文件路径无效，未执行 Git 操作。')
  })

  it('falls back to localized generic text for unknown raw errors', () => {
    expect(formatGitErrorForToast('some unexpected low-level git stderr', zhT)).toBe('Git 操作失败，请稍后重试。')
  })

  it('classifies SSH publickey failures as remote authentication errors', () => {
    const message = formatGitErrorForToast('git@github.com: Permission denied (publickey).', zhT)

    expect(message).toBe('远端仓库鉴权失败，请检查登录状态、SSH Key 或访问权限。')
  })

  it('classifies HTTP 403 remote failures as authentication errors before network errors', () => {
    const message = formatGitErrorForToast(
      'fatal: unable to access https://github.com/example/repo.git/: The requested URL returned error: 403',
      zhT,
    )

    expect(message).toBe('远端仓库鉴权失败，请检查登录状态、SSH Key 或访问权限。')
  })

  it('classifies HTTP 401 remote failures as authentication errors before network errors', () => {
    const message = formatGitErrorForToast(
      'fatal: unable to access https://github.com/example/repo.git/: The requested URL returned error: 401',
      zhT,
    )

    expect(message).toBe('远端仓库鉴权失败，请检查登录状态、SSH Key 或访问权限。')
  })

  it('preserves the conflicting branch name for already-existing branches', () => {
    const message = formatGitErrorForToast("fatal: A branch named 'feature/demo' already exists.", zhT)

    expect(message).toBe('feature/demo 已存在或已被其它 Worktree 使用，请换一个名称或路径。')
  })
})

describe('formatGitWarningForToast', () => {
  it('localizes worktree cleanup warnings and their nested reason', () => {
    const message = formatGitWarningForToast(
      'remove worktree failed: working tree has uncommitted changes',
      zhT,
    )

    expect(message).toBe('源 Worktree 删除失败：当前工作区还有未提交的变更，请先提交或暂存后再试。')
  })
})
