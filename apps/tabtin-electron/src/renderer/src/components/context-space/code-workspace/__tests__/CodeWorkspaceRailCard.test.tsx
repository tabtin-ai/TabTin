import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeWorkspaceRailCard } from '../CodeWorkspaceRailCard'
import { openCodeChangesTab } from '../codeWorkspaceTab'

const { mocks, boundCodeRoot, defaultWorktrees, defaultBranches } = vi.hoisted(() => {
  const boundCodeRoot = {
    bindings: {} as Record<string, { rootPath: string; status: string }>,
  }
  const defaultBranches = [
    { name: 'main', isCurrent: false },
    { name: 'feat/demo', isCurrent: true },
    { name: 'release/260812', isCurrent: false },
  ]
  const defaultWorktrees = [
    {
      path: '/repo',
      branch: 'feat/demo',
      isCurrent: true,
      isDetached: false,
      commitHash: null,
      isBare: false,
      isLocked: false,
    },
    {
      path: '/repo-wt',
      branch: 'feat/wt',
      isCurrent: false,
      isDetached: false,
      commitHash: null,
      isBare: false,
      isLocked: false,
    },
    {
      path: '/repo-detached',
      branch: null,
      isCurrent: false,
      isDetached: true,
      commitHash: 'abc1234',
      isBare: false,
      isLocked: false,
    },
  ]
  const mocks = {
    journalRecords: [] as Array<{
      toolUseId: string
      codeRootPath?: string
      patch: Record<string, unknown>
    }>,
    messagesBySessionId: {} as Record<string, unknown[]>,
    gitStatus: {
      branch: 'feat/demo',
      gitStatus: new Map([['/repo/a.ts', 'M']]),
      stagedStatus: new Map(),
      unstagedStatus: new Map([['/repo/a.ts', 'M']]),
      diffStat: { files: 1, insertions: 12, deletions: 3 },
      isGitRepo: true,
      isLoading: false,
      statusRevision: 1,
      contentRevisions: {},
      refresh: vi.fn(),
    },
    listBranches: vi.fn(async () => ({
      success: true,
      localBranches: defaultBranches,
    })),
    listWorktrees: vi.fn(async () => ({
      success: true,
      worktrees: defaultWorktrees,
    })),
    checkoutBranch: vi.fn(async () => ({ success: true })),
    checkoutSessionBranch: vi.fn(async () => ({ success: true })),
    switchSessionWorktree: vi.fn(async (input: { sessionId: string; rootPath: string }) => {
      boundCodeRoot.bindings[input.sessionId] = {
        rootPath: input.rootPath,
        status: 'active',
      }
      return { success: true, rootPath: input.rootPath }
    }),
    openCodeProject: vi.fn(),
    logGitActionFailure: vi.fn(),
    toast: vi.fn(),
    canvasRail: { iconOnly: false },
  }
  return { mocks, boundCodeRoot, defaultWorktrees, defaultBranches }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; added?: number; deleted?: number; path?: string; branch?: string }) => {
      let text = opts?.defaultValue ?? key
      if (opts?.added != null) text = text.replace(/\{\{added\}\}/g, String(opts.added))
      if (opts?.deleted != null) text = text.replace(/\{\{deleted\}\}/g, String(opts.deleted))
      if (opts?.path != null) text = text.replace(/\{\{path\}\}/g, opts.path)
      if (opts?.branch != null) text = text.replace(/\{\{branch\}\}/g, opts.branch)
      return text
    },
  }),
}))

vi.mock('@components/tabcode/hooks/useGitStatus', () => ({
  useGitStatus: () => mocks.gitStatus,
}))

vi.mock('../../SpaceContextAreaContext', () => ({
  useSpaceContextState: () => ({
    spaceId: 'space-1',
    tabScopeKey: 'space-1',
    activeTabKey: null,
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: {
    spaces: Array<{ id: string; execution_agent_id?: string | null }>
    agentCache: Record<string, never>
    selectedAgent: null
  }) => unknown) => selector({
    spaces: [{ id: 'space-1', execution_agent_id: null }],
    agentCache: {},
    selectedAgent: null,
  }),
}))

vi.mock('@/stores/chat/utils/resolveSessionCodeRoot', () => ({
  resolveSessionCodeRoot: () => '/repo',
}))

vi.mock('@stores/useSessionBoundCodeRootStore', () => {
  const getState = () => ({
    bindingsBySessionId: boundCodeRoot.bindings,
    getBinding: (sessionId: string) => boundCodeRoot.bindings[sessionId] ?? null,
  })
  const useStore = (
    selector: (state: ReturnType<typeof getState>) => unknown,
  ) => selector(getState())
  ;(useStore as typeof useStore & { getState: typeof getState }).getState = getState
  return { useSessionBoundCodeRootStore: useStore }
})

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { messagesBySessionId: Record<string, unknown[]> }) => unknown) =>
    selector({ messagesBySessionId: mocks.messagesBySessionId }),
}))

vi.mock('@components/layout/CanvasRailPortalContext', () => ({
  useCanvasRailPortal: () => ({ iconOnly: mocks.canvasRail.iconOnly }),
}))

vi.mock('../CreateWorktreeDialog', () => ({
  CreateWorktreeDialog: ({
    open,
  }: {
    open: boolean
  }) => (
    open ? <div data-testid="code-workspace-create-worktree-dialog">create</div> : null
  ),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../agentTurnDiffSnapshots', () => ({
  useAgentTurnDiffStore: (selector: (state: { captureFromMessages: () => void }) => unknown) =>
    selector({ captureFromMessages: vi.fn() }),
}))

vi.mock('../switchSessionWorktree', () => ({
  BIND_REASON_I18N_KEY: {
    session_busy: 'codeWorkspace.bindReason.sessionBusy',
    invalid_root_path: 'codeWorkspace.bindReason.invalidPath',
  },
  switchSessionWorktree: (...args: unknown[]) => mocks.switchSessionWorktree(...args),
}))

vi.mock('../checkoutSessionBranch', () => ({
  checkoutSessionBranch: (...args: unknown[]) => mocks.checkoutSessionBranch(...args),
}))

vi.mock('@components/tabcode/utils/gitActionDiagnostics', () => ({
  logGitActionFailure: (...args: unknown[]) => mocks.logGitActionFailure(...args),
}))

vi.mock('@components/tabcode/components/git-workflow/gitErrorMessage', () => ({
  formatGitErrorForToast: (error: unknown) => (typeof error === 'string' ? error : ''),
}))

vi.mock('@components/tabcode/components/TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
    disabled,
  }: {
    open: boolean
    onConfirm: () => void
    confirmLabel?: string
    disabled?: boolean
  }) => (
    open ? (
      <button
        type="button"
        data-testid="stash-confirm"
        disabled={disabled}
        onClick={() => onConfirm()}
      >
        {confirmLabel || 'confirm'}
      </button>
    ) : null
  ),
}))

vi.mock('../codeWorkspaceTab', () => ({
  buildCodeChangesTabKey: (root: string) => `code-changes:${root}`,
  DEFAULT_CODE_CHANGES_VIEW: 'agent',
  openCodeChangesTab: vi.fn(),
  openTabCodeGitPanel: vi.fn(),
}))

vi.mock('../fileEditPatchJournalStore', () => ({
  useFileEditPatchJournalStore: (
    selector: (state: {
      byThread: Record<string, Array<{
        toolUseId: string
        codeRootPath?: string
        patch: Record<string, unknown>
      }>>
      load: () => Promise<void>
    }) => unknown,
  ) => selector({
    byThread: { s1: mocks.journalRecords },
    load: vi.fn(async () => undefined),
  }),
}))

vi.mock('../../workspaceExecutionRootApp', () => ({
  resolveWorkspaceWorkingDir: () => '/repo',
}))

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('@components/ui', () => {
  return {
    toast: (...args: unknown[]) => mocks.toast(...args),
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean
      onOpenChange?: (open: boolean) => void
      children: React.ReactNode
    }) => {
      const childArray = React.Children.toArray(children)
      const trigger = childArray[0]
      const content = childArray[1]
      return (
        <div data-testid="mock-popover" data-open={String(Boolean(open))}>
          {trigger}
          <button
            type="button"
            data-testid="force-open-popover"
            onClick={() => onOpenChange?.(true)}
          >
            open
          </button>
          {open ? content : null}
        </div>
      )
    },
    PopoverTrigger: ({ asChild, children }: { asChild?: boolean; children: React.ReactNode }) => {
      void asChild
      return <>{children}</>
    },
    PopoverContent: ({
      children,
      side,
      ...rest
    }: {
      children: React.ReactNode
      side?: string
      onOpenAutoFocus?: (event: Event) => void
      sideOffset?: number
      align?: string
      className?: string
      'data-testid'?: string
    }) => (
      <div
        data-testid={rest['data-testid'] || 'code-workspace-popover'}
        data-side={side}
      >
        {children}
      </div>
    ),
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandInput: ({
      placeholder,
    }: {
      placeholder?: string
      containerClassName?: string
      className?: string
    }) => (
      <input data-testid="branch-search-input" placeholder={placeholder} />
    ),
    CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({
      children,
      heading,
    }: { children: React.ReactNode; heading?: string }) => (
      <div>
        {heading ? <div>{heading}</div> : null}
        {children}
      </div>
    ),
    CommandItem: ({
      children,
      value,
      onSelect,
      disabled,
    }: {
      children: React.ReactNode
      value?: string
      onSelect?: () => void
      disabled?: boolean
    }) => (
      <button
        type="button"
        data-testid={`branch-item-${value}`}
        disabled={disabled}
        onClick={() => onSelect?.()}
      >
        {children}
      </button>
    ),
  }
})

function railEditorTurn(blocks: unknown[]) {
  return [
    {
      id: 'u1',
      role: 'user',
      content: 'edit files',
      created_at: '2026-08-13T00:00:00Z',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      created_at: '2026-08-13T00:00:01Z',
      message_kind: 'llm',
      agent_run_id: 'run-1',
      content_blocks_json: blocks,
      blocks: (blocks as object[]).map((block, index) => ({
        index,
        block_id: `b-${index}`,
        block,
        finalized: true,
        partial: false,
      })),
    },
  ]
}

describe('CodeWorkspaceRailCard', () => {
  beforeEach(() => {
    mocks.journalRecords = []
    mocks.messagesBySessionId = {}
    mocks.gitStatus.branch = 'feat/demo'
    mocks.gitStatus.diffStat = { files: 1, insertions: 12, deletions: 3 }
    mocks.gitStatus.isGitRepo = true
    mocks.gitStatus.isLoading = false
    mocks.gitStatus.statusRevision = 1
    mocks.gitStatus.refresh.mockClear()
    mocks.checkoutBranch.mockClear()
    mocks.checkoutBranch.mockResolvedValue({ success: true })
    mocks.checkoutSessionBranch.mockClear()
    mocks.checkoutSessionBranch.mockResolvedValue({ success: true })
    mocks.logGitActionFailure.mockClear()
    mocks.toast.mockClear()
    mocks.listBranches.mockReset()
    mocks.listBranches.mockResolvedValue({
      success: true,
      localBranches: defaultBranches,
    })
    mocks.listWorktrees.mockReset()
    mocks.listWorktrees.mockResolvedValue({
      success: true,
      worktrees: defaultWorktrees,
    })
    mocks.switchSessionWorktree.mockReset()
    mocks.switchSessionWorktree.mockImplementation(async (input: { sessionId: string; rootPath: string }) => {
      boundCodeRoot.bindings[input.sessionId] = {
        rootPath: input.rootPath,
        status: 'active',
      }
      return { success: true, rootPath: input.rootPath }
    })
    mocks.openCodeProject.mockClear()
    mocks.canvasRail.iconOnly = false
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: {
          listBranches: mocks.listBranches,
          listWorktrees: mocks.listWorktrees,
          checkoutBranch: mocks.checkoutBranch,
        },
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('静默展示变更统计，不出现读取变更中文案', async () => {
    mocks.gitStatus.isLoading = true
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId('code-workspace-rail-card')).toBeTruthy()
    })
    expect(screen.getByTestId('code-workspace-changes-row').textContent).toContain('变更')
    expect(screen.getByTestId('code-workspace-changes-row').textContent).not.toContain('+12')
    expect(screen.getByTestId('code-workspace-changes-row').textContent).not.toContain('-3')
    expect(screen.queryByText(/读取变更/)).toBeNull()
    expect(screen.queryByText(/Loading changes/i)).toBeNull()
  })

  it('确认非 Git 代码根后不渲染整个工作台', () => {
    mocks.gitStatus.isGitRepo = false
    mocks.gitStatus.statusRevision = 2
    const { container } = render(
      <CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />,
    )
    expect(container.querySelector('[data-testid="code-workspace-rail-card"]')).toBeNull()
    expect(screen.queryByText(/当前代码根不是 Git 仓库/)).toBeNull()
  })

  it('首帧未确认前仍稳定渲染入口，避免闪空', async () => {
    mocks.gitStatus.isGitRepo = false
    mocks.gitStatus.statusRevision = 0
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    expect(screen.getByTestId('code-workspace-rail-card')).toBeTruthy()
    expect(screen.getByTestId('code-workspace-changes-row').textContent).toContain('变更')
    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalled()
    })
  })

  it('分支弹层从左侧展开，可搜索、切换并提供创建分支入口', async () => {
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)

    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalled()
    })

    // 第一个 Popover 是 worktree，第二个是分支
    fireEvent.click(screen.getAllByTestId('force-open-popover')[1]!)

    const popover = await screen.findByTestId('code-workspace-branch-popover')
    expect(popover.getAttribute('data-side')).toBe('left')
    expect(screen.getByTestId('branch-search-input')).toBeTruthy()
    expect(screen.getByTestId('branch-item-main')).toBeTruthy()
    expect(screen.getByTestId('branch-item-feat/demo')).toBeTruthy()
    expect(screen.getByTestId('branch-item-release/260812')).toBeTruthy()
    expect(screen.getByTestId('code-workspace-add-branch').textContent).toContain('创建新分支')

    await act(async () => {
      fireEvent.click(screen.getByTestId('branch-item-main'))
    })

    await waitFor(() => {
      expect(mocks.checkoutSessionBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          rootPath: '/repo',
          branch: 'main',
        }),
      )
    })
  })

  it('在分支弹层内创建并切换到新分支', async () => {
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)

    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalled()
    })
    fireEvent.click(screen.getAllByTestId('force-open-popover')[1]!)
    const listCallCountBeforeCreate = mocks.listBranches.mock.calls.length

    fireEvent.click(await screen.findByTestId('code-workspace-add-branch'))
    const input = await screen.findByTestId('code-workspace-new-branch-input')
    expect(screen.getByTestId('code-workspace-create-branch-help').textContent).toContain(
      'feat/demo',
    )
    fireEvent.change(input, { target: { value: 'main' } })
    expect(
      screen.getByTestId('code-workspace-confirm-create-branch'),
    ).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: 'feat/inline-branch-create' } })
    expect(
      screen.getByTestId('code-workspace-confirm-create-branch'),
    ).toHaveProperty('disabled', false)

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('code-workspace-confirm-create-branch'),
      )
    })

    await waitFor(() => {
      expect(mocks.checkoutBranch).toHaveBeenCalledWith('/repo', {
        branch: 'feat/inline-branch-create',
        create: true,
      })
    })
    expect(mocks.gitStatus.refresh).toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.listBranches.mock.calls.length).toBeGreaterThan(
        listCallCountBeforeCreate,
      )
    })
  })

  it('创建分支失败时提示错误并写诊断日志', async () => {
    mocks.checkoutBranch.mockResolvedValue({
      success: false,
      error: 'branch already exists',
    })
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)

    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalled()
    })
    fireEvent.click(screen.getAllByTestId('force-open-popover')[1]!)
    fireEvent.click(await screen.findByTestId('code-workspace-add-branch'))
    fireEvent.change(
      await screen.findByTestId('code-workspace-new-branch-input'),
      {
        target: { value: 'feat/new-branch' },
      },
    )

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('code-workspace-confirm-create-branch'),
      )
    })

    await waitFor(() => {
      expect(mocks.logGitActionFailure).toHaveBeenCalledWith(
        'code-workspace:create-branch',
        '/repo',
        [],
        'branch already exists',
      )
    })
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '创建失败',
        description: 'branch already exists',
      }),
    )
  })

  it('代码根触发行只显示文件夹名，悬停带完整路径', async () => {
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })

    const trigger = screen.getByTestId('code-workspace-worktree-trigger')
    expect(trigger.textContent).toContain('repo')
    expect(trigger.textContent).not.toContain('本地')
    expect(trigger.getAttribute('title')).toBe('/repo')
  })

  it('worktree 弹层分组展示文件夹名与分支，路径仅在 title', async () => {
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })

    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    const popover = await screen.findByTestId('code-workspace-worktree-popover')
    expect(popover.getAttribute('data-side')).toBe('left')
    expect(screen.getByText('主目录')).toBeTruthy()
    expect(screen.getByText('关联 worktree')).toBeTruthy()

    const mainItem = screen.getByTestId('worktree-item-/repo')
    expect(mainItem.textContent).toContain('repo')
    expect(mainItem.textContent).toContain('feat/demo')
    expect(mainItem.textContent).not.toContain('/repo')
    expect(mainItem.getAttribute('title')).toBe('/repo')

    const linkedItem = screen.getByTestId('worktree-item-/repo-wt')
    expect(linkedItem.textContent).toContain('repo-wt')
    expect(linkedItem.textContent).toContain('feat/wt')
    expect(linkedItem.getAttribute('title')).toBe('/repo-wt')

    const detachedItem = screen.getByTestId('worktree-item-/repo-detached')
    expect(detachedItem.textContent).toContain('分离头指针')
    expect(screen.getByTestId('code-workspace-add-worktree').textContent).toContain('新增 worktree')
    expect(screen.queryByTestId('code-workspace-linked-empty')).toBeNull()
  })

  it('仅有主目录时展示关联 worktree 空态和底部新增入口', async () => {
    mocks.listWorktrees.mockResolvedValue({
      success: true,
      worktrees: [
        {
          path: '/repo',
          branch: 'feat/demo',
          isCurrent: true,
          isDetached: false,
          commitHash: null,
          isBare: false,
          isLocked: false,
        },
      ],
    })
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })
    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    expect(await screen.findByTestId('code-workspace-linked-empty')).toBeTruthy()
    expect(screen.getByText('主目录')).toBeTruthy()
    expect(screen.getByTestId('code-workspace-add-worktree')).toBeTruthy()
  })

  it('读取失败时展示中性失败态，不假装没有关联 worktree', async () => {
    mocks.listWorktrees.mockResolvedValue({
      success: false,
      worktrees: [],
      error: 'boom',
    })
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })
    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    expect(await screen.findByText('未能读取 worktree 列表')).toBeTruthy()
    expect(screen.queryByTestId('code-workspace-linked-empty')).toBeNull()
    expect(screen.getByTestId('code-workspace-add-worktree')).toBeTruthy()
  })

  it('点击新增 worktree 不展开代码工作台', async () => {
    const expandCanvas = vi.fn()
    mocks.listWorktrees.mockResolvedValue({
      success: true,
      worktrees: [
        {
          path: '/repo',
          branch: 'feat/demo',
          isCurrent: true,
          isDetached: false,
          commitHash: null,
          isBare: false,
          isLocked: false,
        },
      ],
    })
    render(<CodeWorkspaceRailCard expandCanvas={expandCanvas} sessionId="s1" />)
    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })
    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    fireEvent.click(await screen.findByTestId('code-workspace-add-worktree'))
    expect(expandCanvas).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-workspace-create-worktree-dialog')).toBeTruthy()
  })

  it('选择 worktree 后静默切换，不展开画布', async () => {
    const expandCanvas = vi.fn()
    render(<CodeWorkspaceRailCard expandCanvas={expandCanvas} sessionId="s1" />)

    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })

    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    const linkedItem = await screen.findByTestId('worktree-item-/repo-wt')
    await act(async () => {
      fireEvent.click(linkedItem)
    })

    await waitFor(() => {
      expect(mocks.switchSessionWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's1',
          rootPath: '/repo-wt',
          previousRootPath: '/repo',
          branch: 'feat/wt',
        }),
      )
    })
    expect(expandCanvas).not.toHaveBeenCalled()
    const call = mocks.switchSessionWorktree.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call).not.toHaveProperty('openTabCode')
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        description: expect.stringContaining('/repo-wt'),
      }),
    )
  })

  it('切换 worktree 失败时 toast destructive 报错', async () => {
    mocks.switchSessionWorktree.mockResolvedValue({
      success: false,
      reason: 'session_busy',
    })
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)

    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })

    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    const linkedItem = await screen.findByTestId('worktree-item-/repo-wt')
    await act(async () => {
      fireEvent.click(linkedItem)
    })

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: '切换失败',
        }),
      )
    })
  })

  it('切换 worktree 抛错时也会 toast', async () => {
    mocks.switchSessionWorktree.mockRejectedValue(new Error('IPC exploded'))
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)

    await waitFor(() => {
      expect(mocks.listWorktrees).toHaveBeenCalled()
    })

    fireEvent.click(screen.getAllByTestId('force-open-popover')[0]!)
    const linkedItem = await screen.findByTestId('worktree-item-/repo-wt')
    await act(async () => {
      fireEvent.click(linkedItem)
    })

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
        }),
      )
    })
  })

  it('脏树确认后 checkout 失败会 toast 并写诊断日志', async () => {
    mocks.checkoutSessionBranch
      .mockResolvedValueOnce({ success: false, needsStashConfirm: true })
      .mockResolvedValueOnce({
        success: false,
        phase: 'checkout-after-stash',
        stashed: true,
        error: '__localized__:变更已暂存到 stash，但分支未能切换：目标被占用',
      })

    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(mocks.listBranches).toHaveBeenCalled()
    })

    fireEvent.click(screen.getAllByTestId('force-open-popover')[1]!)
    await act(async () => {
      fireEvent.click(screen.getByTestId('branch-item-main'))
    })

    const confirm = await screen.findByTestId('stash-confirm')
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => {
      expect(mocks.checkoutSessionBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'main',
          confirmedStash: true,
        }),
      )
    })
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('变更已暂存到 stash'),
      }),
    )
    expect(mocks.logGitActionFailure).toHaveBeenCalledWith(
      'code-workspace:checkout-after-stash',
      '/repo',
      [],
      expect.stringContaining('变更已暂存到 stash'),
    )
  })

  it('shows folded Agent turn +/- on the changes row, not git working-tree stats', async () => {
    mocks.messagesBySessionId = {
      s1: railEditorTurn([
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: JSON.stringify({ success: true }),
        },
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'edit_file',
          input: { path: 'a.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: JSON.stringify({ success: true }),
        },
        {
          type: 'tool_use',
          id: 'tu_add',
          name: 'write_file',
          input: { path: 'b.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu_add',
          content: JSON.stringify({ success: true }),
        },
      ]),
    }
    mocks.journalRecords = [
      {
        toolUseId: 'tu_1',
        codeRootPath: '/repo',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          beforeFull: 'one',
          afterFull: 'two',
        },
      },
      {
        toolUseId: 'tu_2',
        codeRootPath: '/repo',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          beforeFull: 'two',
          afterFull: 'three',
        },
      },
      {
        toolUseId: 'tu_add',
        codeRootPath: '/repo',
        patch: {
          toolName: 'write_file',
          relativePath: 'b.ts',
          status: 'added',
          afterFull: 'created',
        },
      },
    ]
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId('code-workspace-changes-row').textContent).toContain('+2')
    })
    const label = screen.getByTestId('code-workspace-changes-row').textContent || ''
    expect(label).toContain('-1')
    expect(label).not.toContain('+12')
    expect(label).not.toContain('-3')
  })

  it('hides previous-turn +/- while a new user message is pending', async () => {
    mocks.messagesBySessionId = {
      s1: [
        ...railEditorTurn([
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'edit_file',
            input: { path: 'a.ts' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: JSON.stringify({ success: true }),
          },
        ]),
        {
          id: 'u2',
          role: 'user',
          content: 'next task',
          created_at: '2026-08-13T00:00:02Z',
        },
      ],
    }
    mocks.journalRecords = [
      {
        toolUseId: 'tu_1',
        codeRootPath: '/repo',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          beforeFull: 'one',
          afterFull: 'two',
        },
      },
    ]
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId('code-workspace-changes-row')).toBeTruthy()
    })
    const label = screen.getByTestId('code-workspace-changes-row').textContent || ''
    expect(label).toContain('变更')
    expect(label).not.toContain('+1')
    expect(label).not.toContain('-1')
    expect(label).not.toContain('+12')
  })

  it('hides +0/-0 on the changes row', async () => {
    mocks.gitStatus.diffStat = { files: 0, insertions: 0, deletions: 0 }
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId('code-workspace-changes-row')).toBeTruthy()
    })
    expect(screen.getByTestId('code-workspace-changes-row').textContent).toContain('变更')
    expect(screen.getByTestId('code-workspace-changes-row').textContent).not.toContain('+0')
    expect(screen.getByTestId('code-workspace-changes-row').textContent).not.toContain('-0')
  })

  it('opens the latest Agent turn view from the workbench changes row', async () => {
    vi.mocked(openCodeChangesTab).mockClear()
    const expandCanvas = vi.fn()
    render(<CodeWorkspaceRailCard expandCanvas={expandCanvas} sessionId="s1" />)
    fireEvent.click(screen.getByTestId('code-workspace-changes-row'))
    expect(openCodeChangesTab).toHaveBeenCalledWith(
      expect.objectContaining({
        initialView: 'agent',
        sessionId: 's1',
      }),
    )
  })

  it('opens the latest Agent turn for the current code root after switching back', async () => {
    mocks.messagesBySessionId = {
      s1: [
        ...railEditorTurn([
          {
            type: 'tool_use',
            id: 'tu_a',
            name: 'edit_file',
            input: { path: 'a.ts' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_a',
            content: JSON.stringify({ success: true }),
          },
        ]),
        {
          id: 'u2',
          role: 'user',
          content: 'edit in worktree B',
          created_at: '2026-08-13T00:00:02Z',
        },
        {
          id: 'a2',
          role: 'assistant',
          content: '',
          created_at: '2026-08-13T00:00:03Z',
          message_kind: 'llm',
          agent_run_id: 'run-2',
          content_blocks_json: [
            {
              type: 'tool_use',
              id: 'tu_b',
              name: 'edit_file',
              input: { path: 'a.ts' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tu_b',
              content: JSON.stringify({ success: true }),
            },
          ],
          blocks: [
            {
              index: 0,
              block_id: 'b-a2-0',
              block: {
                type: 'tool_use',
                id: 'tu_b',
                name: 'edit_file',
                input: { path: 'a.ts' },
              },
              finalized: true,
              partial: false,
            },
            {
              index: 1,
              block_id: 'b-a2-1',
              block: {
                type: 'tool_result',
                tool_use_id: 'tu_b',
                content: JSON.stringify({ success: true }),
              },
              finalized: true,
              partial: false,
            },
          ],
        },
      ],
    }
    mocks.journalRecords = [
      {
        toolUseId: 'tu_a',
        codeRootPath: '/repo',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'a-old',
          after: 'a-new',
        },
      },
      {
        toolUseId: 'tu_b',
        codeRootPath: '/repo-wt',
        patch: {
          toolName: 'edit_file',
          relativePath: 'a.ts',
          status: 'modified',
          before: 'b-old',
          after: 'b-new',
        },
      },
    ]
    vi.mocked(openCodeChangesTab).mockClear()
    render(<CodeWorkspaceRailCard expandCanvas={vi.fn()} sessionId="s1" />)

    await waitFor(() => {
      expect(screen.getByTestId('code-workspace-changes-row').textContent).toContain('+1')
    })
    fireEvent.click(screen.getByTestId('code-workspace-changes-row'))

    expect(openCodeChangesTab).toHaveBeenCalledWith(
      expect.objectContaining({ agentTurnEndMessageId: 'a1' }),
    )
  })
})
