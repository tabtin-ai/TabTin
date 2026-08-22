import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkoutSessionBranch } from '../checkoutSessionBranch'
import { formatGitErrorForToast } from '@components/tabcode/components/git-workflow/gitErrorMessage'

const stash = vi.fn()
const checkoutBranch = vi.fn()

beforeEach(() => {
  stash.mockReset()
  checkoutBranch.mockReset()
  // @ts-expect-error test stub
  global.window = {
    tabtin: {
      git: {
        stash,
        checkoutBranch,
      },
    },
  }
})

const t = ((key: string, opts?: { branch?: string; reason?: string; defaultValue?: string }) => {
  if (key === 'gitFlow.stashMessage') return `stash-for-${opts?.branch}`
  if (key === 'gitFlow.gitErrors.checkoutAfterStashFailed') {
    return `变更已暂存到 stash，但分支未能切换：${opts?.reason}`
  }
  if (key === 'gitFlow.gitErrors.workingTreeDirty') {
    return '当前工作区还有未提交的变更，请先提交或暂存后再试。'
  }
  if (key === 'gitFlow.gitErrors.branchRequired') return '请先填写分支名称。'
  if (key === 'gitFlow.unknownError') return '未知错误'
  if (key === 'gitFlow.gitErrors.generic') return 'Git 操作失败，请稍后重试。'
  return opts?.defaultValue ?? key
}) as never

describe('checkoutSessionBranch', () => {
  it('checks out directly when the tree is clean', async () => {
    checkoutBranch.mockResolvedValue({ success: true })
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'main',
      stagedCount: 0,
      unstagedCount: 0,
      t,
    })
    expect(result.success).toBe(true)
    expect(stash).not.toHaveBeenCalled()
    expect(checkoutBranch).toHaveBeenCalledWith('/repo', { branch: 'main' })
  })

  it('asks for stash confirmation when dirty and not confirmed', async () => {
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'main',
      stagedCount: 1,
      unstagedCount: 0,
      t,
    })
    expect(result.needsStashConfirm).toBe(true)
    expect(stash).not.toHaveBeenCalled()
    expect(checkoutBranch).not.toHaveBeenCalled()
  })

  it('asks for stash confirmation when only dirtyFileCount is set (conflict-only)', async () => {
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'main',
      stagedCount: 0,
      unstagedCount: 0,
      dirtyFileCount: 2,
      t,
    })
    expect(result.needsStashConfirm).toBe(true)
    expect(stash).not.toHaveBeenCalled()
  })

  it('checks out directly without confirm when only untracked files exist', async () => {
    checkoutBranch.mockResolvedValue({ success: true })
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'feat',
      stagedCount: 0,
      unstagedCount: 3,
      dirtyFileCount: 3,
      untrackedCount: 3,
      t,
    })
    expect(result.success).toBe(true)
    expect(result.needsStashConfirm).toBeUndefined()
    expect(stash).not.toHaveBeenCalled()
    expect(checkoutBranch).toHaveBeenCalledWith('/repo', { branch: 'feat', allowDirty: true })
  })

  it('asks for stash confirm when untracked-only checkout is blocked by overwrite', async () => {
    checkoutBranch.mockResolvedValue({
      success: false,
      error: 'error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.md',
    })
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'feat',
      stagedCount: 0,
      unstagedCount: 1,
      dirtyFileCount: 1,
      untrackedCount: 1,
      t,
    })
    expect(result.needsStashConfirm).toBe(true)
    expect(stash).not.toHaveBeenCalled()
    expect(checkoutBranch).toHaveBeenCalledWith('/repo', { branch: 'feat', allowDirty: true })
  })

  it('stashes then checks out with allowDirty when confirmed', async () => {
    stash.mockResolvedValue({ success: true })
    checkoutBranch.mockResolvedValue({ success: true })
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'feat',
      stagedCount: 0,
      unstagedCount: 2,
      confirmedStash: true,
      t,
    })
    expect(result.success).toBe(true)
    expect(stash).toHaveBeenCalledWith('/repo', 'save', {
      message: 'stash-for-feat',
      includeUntracked: true,
    })
    expect(checkoutBranch).toHaveBeenCalledWith('/repo', { branch: 'feat', allowDirty: true })
  })

  it('returns checkout-after-stash phase when stash succeeds but checkout fails', async () => {
    stash.mockResolvedValue({ success: true })
    checkoutBranch.mockResolvedValue({
      success: false,
      error: 'working tree has uncommitted changes, please commit/stash first',
    })
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'feat',
      stagedCount: 1,
      unstagedCount: 0,
      confirmedStash: true,
      t,
    })
    expect(result.success).toBe(false)
    expect(result.phase).toBe('checkout-after-stash')
    expect(result.stashed).toBe(true)
    expect(formatGitErrorForToast(result.error, t)).toContain('变更已暂存到 stash')
    expect(formatGitErrorForToast(result.error, t)).not.toBe(
      '当前工作区还有未提交的变更，请先提交或暂存后再试。',
    )
  })

  it('returns stash phase when stash IPC rejects', async () => {
    stash.mockRejectedValue(new Error('IPC_REJECT'))
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'feat',
      stagedCount: 1,
      unstagedCount: 0,
      confirmedStash: true,
      t,
    })
    expect(result.success).toBe(false)
    expect(result.phase).toBe('stash')
    expect(result.stashed).toBe(false)
    expect(checkoutBranch).not.toHaveBeenCalled()
  })

  it('returns checkout-after-stash when checkout IPC rejects after stash', async () => {
    stash.mockResolvedValue({ success: true })
    checkoutBranch.mockRejectedValue(new Error('channel missing'))
    const result = await checkoutSessionBranch({
      rootPath: '/repo',
      branch: 'feat',
      stagedCount: 1,
      unstagedCount: 0,
      confirmedStash: true,
      t,
    })
    expect(result.success).toBe(false)
    expect(result.phase).toBe('checkout-after-stash')
    expect(result.stashed).toBe(true)
    expect(formatGitErrorForToast(result.error, t)).toContain('变更已暂存到 stash')
  })
})
