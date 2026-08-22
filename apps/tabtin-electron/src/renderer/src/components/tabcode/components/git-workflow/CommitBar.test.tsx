import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api'
import { generateCommitMessage } from '@/services/tabcodeCommitMessageApi'
import { CommitBar, type GitActionPresentation } from './CommitBar'
import { collectCommitMessageContext } from './collectStagedCommitContext'

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  push: vi.fn(),
  stageFiles: vi.fn(),
  toast: vi.fn(),
}))

const collectCommitMessageContextMock = vi.mocked(collectCommitMessageContext)
const generateCommitMessageMock = vi.mocked(generateCommitMessage)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'gitFlow.commitSucceededPushFailed') {
        return `提交已成功，但推送失败：${String(options?.reason ?? '')}`
      }
      return key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { onSelect?: () => void }) => (
    <button {...props} onClick={onSelect}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  toast: mocks.toast,
}))

vi.mock('../TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
  }: {
    open: boolean
    onConfirm: () => void
    confirmLabel?: string
  }) => open ? <button onClick={onConfirm}>{confirmLabel ?? 'confirm'}</button> : null,
}))

vi.mock('../../utils/gitActionDiagnostics', () => ({
  logGitActionFailure: vi.fn(),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: { getEffectiveOrganizationId: () => string | null }) => unknown) =>
    selector({ getEffectiveOrganizationId: () => 'org-1' }),
}))

vi.mock('./collectStagedCommitContext', () => ({
  collectCommitMessageContext: vi.fn(),
  collectStagedCommitContext: vi.fn(),
}))

vi.mock('@/services/tabcodeCommitMessageApi', () => ({
  generateCommitMessage: vi.fn(),
}))

vi.mock('@/utils/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return {
    createLogger: () => stub,
    logger: stub,
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      git: {
        commit: mocks.commit,
        push: mocks.push,
        stageFiles: mocks.stageFiles,
        rawDiff: vi.fn(),
      },
    },
  })
  mocks.commit.mockResolvedValue({ success: true, commitHash: 'abc123' })
  mocks.push.mockResolvedValue({ success: true })
  mocks.stageFiles.mockResolvedValue({ success: true })
})

function createRunGitAction() {
  return vi.fn(async (
    _key: string,
    action: () => Promise<{ success: boolean; error?: string } | null>,
    successDescription: string,
    presentation?: GitActionPresentation,
  ) => {
    const result = await action()
    if (result?.success) {
      if (presentation?.showSuccessToast !== false) {
        mocks.toast({ description: successDescription })
      }
      return true
    }
    mocks.toast({
      description: presentation?.formatError?.(result?.error) ?? String(result?.error),
    })
    return false
  })
}

function renderCommitBar(
  runGitAction: ReturnType<typeof createRunGitAction>,
  counts: { staged: number; unstaged: number } = { staged: 1, unstaged: 1 },
) {
  return render(
    <CommitBar
      rootPath="/repo"
      currentBranchName="main"
      branchMeta={{
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        isDetached: false,
      }}
      stagedCount={counts.staged}
      unstagedCount={counts.unstaged}
      actionKey={null}
      runGitAction={runGitAction}
    />,
  )
}

function enterCommitMessageAndClick(buttonName: string) {
  fireEvent.change(screen.getByPlaceholderText('gitFlow.commitMessagePlaceholder'), {
    target: { value: 'fix: preserve dirty worktree' },
  })
  fireEvent.click(screen.getByRole('button', { name: buttonName }))
}

describe('CommitBar', () => {
  it('空态 commit 输入框为单行', () => {
    renderCommitBar(createRunGitAction())
    const textarea = screen.getByPlaceholderText(
      'gitFlow.commitMessagePlaceholder',
    ) as HTMLTextAreaElement
    expect(textarea.rows).toBe(1)
  })

  it('提交并推送时允许保留未暂存文件，并只在组合操作完成后报告成功', async () => {
    const runGitAction = createRunGitAction()

    renderCommitBar(runGitAction)
    enterCommitMessageAndClick('gitFlow.commitAndPush')

    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce())

    expect(mocks.commit).toHaveBeenCalledWith('/repo', 'fix: preserve dirty worktree')
    expect(mocks.push).toHaveBeenCalledWith('/repo', {
      remote: 'origin',
      branch: 'main',
      setUpstream: false,
      allowDirty: true,
    })
    expect(runGitAction.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ showSuccessToast: false }),
    )
    expect(runGitAction.mock.calls[1]?.[2]).toBe('gitFlow.commitAndPushSuccess')
    expect(mocks.toast).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith({
      description: 'gitFlow.commitAndPushSuccess',
    })
  })

  it('暂存区为空时确认全部暂存后继续完成组合操作', async () => {
    const runGitAction = createRunGitAction()

    renderCommitBar(runGitAction, { staged: 0, unstaged: 1 })
    enterCommitMessageAndClick('gitFlow.commitAndPush')
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.stageAll' }))

    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce())

    expect(mocks.stageFiles).toHaveBeenCalledWith('/repo')
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.push).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith({
      description: 'gitFlow.commitAndPushSuccess',
    })
  })

  it('单独提交保持原有成功提示且不会推送', async () => {
    const runGitAction = createRunGitAction()

    renderCommitBar(runGitAction)
    enterCommitMessageAndClick('gitFlow.commit')

    await waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce())

    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith({
      description: 'gitFlow.commitSuccess',
    })
  })

  it('提交失败时不会继续推送', async () => {
    mocks.commit.mockResolvedValueOnce({
      success: false,
      error: 'commit rejected',
    })
    const runGitAction = createRunGitAction()

    renderCommitBar(runGitAction)
    enterCommitMessageAndClick('gitFlow.commitAndPush')

    await waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce())

    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('推送失败提示保留提交已成功的事实', async () => {
    mocks.push.mockResolvedValueOnce({
      success: false,
      error: 'network unavailable',
    })
    const runGitAction = createRunGitAction()

    renderCommitBar(runGitAction)
    enterCommitMessageAndClick('gitFlow.commitAndPush')

    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce())

    const pushPresentation = runGitAction.mock.calls[1]?.[3] as {
      formatError?: (error: unknown) => string
    } | undefined
    expect(pushPresentation?.formatError?.('network unavailable')).toBe(
      '提交已成功，但推送失败：gitFlow.gitErrors.generic',
    )
    expect(mocks.toast).toHaveBeenCalledOnce()
    expect(mocks.toast).toHaveBeenCalledWith({
      description: '提交已成功，但推送失败：gitFlow.gitErrors.generic',
    })
  })

  it('空框生成后直接填入提交信息', async () => {
    collectCommitMessageContextMock.mockResolvedValueOnce({
      ok: true,
      files: ['apps/foo.ts'],
      diffExcerpt: 'diff --git a/apps/foo.ts',
      truncated: false,
      scope: 'staged',
    })
    generateCommitMessageMock.mockResolvedValueOnce({
      commitMessage: 'feat(tabcode): add ai commit message',
    })

    renderCommitBar(createRunGitAction())
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    const textarea = screen.getByPlaceholderText(
      'gitFlow.commitMessagePlaceholder',
    ) as HTMLTextAreaElement
    await waitFor(() => {
      expect(textarea.value).toBe('feat(tabcode): add ai commit message')
    })
    expect(collectCommitMessageContextMock).toHaveBeenCalledWith('/repo', 'staged')
    expect(screen.queryByRole('button', { name: 'gitFlow.replaceCommitMessage' })).toBeNull()
  })

  it('有暂存时优先用 staged 策略，即使还有未暂存变更', async () => {
    collectCommitMessageContextMock.mockResolvedValueOnce({
      ok: true,
      files: ['apps/staged.ts'],
      diffExcerpt: 'diff --git a/apps/staged.ts',
      truncated: false,
      scope: 'staged',
    })
    generateCommitMessageMock.mockResolvedValueOnce({
      commitMessage: 'feat(tabcode): staged only',
    })

    renderCommitBar(createRunGitAction(), { staged: 2, unstaged: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    await waitFor(() => {
      expect(collectCommitMessageContextMock).toHaveBeenCalledWith('/repo', 'staged')
    })
    expect(generateCommitMessageMock).toHaveBeenCalled()
  })

  it('无暂存但有工作区变更时按钮可用并走 workspace 策略', async () => {
    collectCommitMessageContextMock.mockResolvedValueOnce({
      ok: true,
      files: ['apps/workspace.ts'],
      diffExcerpt: 'diff --git a/apps/workspace.ts',
      truncated: false,
      scope: 'workspace',
    })
    generateCommitMessageMock.mockResolvedValueOnce({
      commitMessage: 'feat(tabcode): workspace changes',
    })

    renderCommitBar(createRunGitAction(), { staged: 0, unstaged: 2 })
    const button = screen.getByRole('button', {
      name: 'gitFlow.generateCommitMessage',
    }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    const textarea = screen.getByPlaceholderText(
      'gitFlow.commitMessagePlaceholder',
    ) as HTMLTextAreaElement
    await waitFor(() => {
      expect(textarea.value).toBe('feat(tabcode): workspace changes')
    })
    expect(collectCommitMessageContextMock).toHaveBeenCalledWith('/repo', 'workspace')
  })

  it('无任何变更时点击仅提示且不收集不请求', async () => {
    renderCommitBar(createRunGitAction(), { staged: 0, unstaged: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'gitFlow.errorTitle',
        description: 'gitFlow.generateCommitMessageNoChanges',
      })
    })
    expect(collectCommitMessageContextMock).not.toHaveBeenCalled()
    expect(generateCommitMessageMock).not.toHaveBeenCalled()
  })

  it('已有草稿时生成需确认后才替换', async () => {
    collectCommitMessageContextMock.mockResolvedValueOnce({
      ok: true,
      files: ['apps/foo.ts'],
      diffExcerpt: 'diff --git a/apps/foo.ts',
      truncated: false,
      scope: 'staged',
    })
    generateCommitMessageMock.mockResolvedValueOnce({
      commitMessage: 'feat(tabcode): generated',
    })

    renderCommitBar(createRunGitAction())
    const textarea = screen.getByPlaceholderText(
      'gitFlow.commitMessagePlaceholder',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'wip: draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'gitFlow.replaceCommitMessage' })).toBeTruthy()
    })
    expect(textarea.value).toBe('wip: draft')
    expect(
      (screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.replaceCommitMessage' }))
    await waitFor(() => {
      expect(textarea.value).toBe('feat(tabcode): generated')
    })
  })

  it('生成期间写入草稿后按最新内容要求确认替换', async () => {
    let resolveContext!: (value: Awaited<ReturnType<typeof collectCommitMessageContext>>) => void
    collectCommitMessageContextMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveContext = resolve
      }),
    )
    generateCommitMessageMock.mockResolvedValueOnce({
      commitMessage: 'feat(tabcode): late draft',
    })

    renderCommitBar(createRunGitAction())
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    const textarea = screen.getByPlaceholderText(
      'gitFlow.commitMessagePlaceholder',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'typed while generating' } })
    resolveContext({
      ok: true,
      files: ['apps/foo.ts'],
      diffExcerpt: 'diff --git a/apps/foo.ts',
      truncated: false,
      scope: 'staged',
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'gitFlow.replaceCommitMessage' })).toBeTruthy()
    })
    expect(textarea.value).toBe('typed while generating')
  })

  it('敏感变更内容阻止生成并提示', async () => {
    collectCommitMessageContextMock.mockResolvedValueOnce({
      ok: false,
      reason: 'sensitive',
      scope: 'staged',
    })

    renderCommitBar(createRunGitAction())
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'gitFlow.errorTitle',
        description: 'gitFlow.generateCommitMessageSensitive',
      })
    })
    expect(generateCommitMessageMock).not.toHaveBeenCalled()
  })

  it('额度不足时提示 402', async () => {
    collectCommitMessageContextMock.mockResolvedValueOnce({
      ok: true,
      files: ['apps/foo.ts'],
      diffExcerpt: 'diff --git a/apps/foo.ts',
      truncated: false,
      scope: 'staged',
    })
    generateCommitMessageMock.mockRejectedValueOnce(
      new ApiError('budget exceeded', 402),
    )

    renderCommitBar(createRunGitAction())
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.generateCommitMessage' }))

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'gitFlow.errorTitle',
        description: 'gitFlow.generateCommitMessageBudgetExceeded',
      })
    })
  })
})
