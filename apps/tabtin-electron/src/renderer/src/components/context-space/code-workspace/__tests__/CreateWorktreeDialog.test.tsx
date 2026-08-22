import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateWorktreeDialog } from '../CreateWorktreeDialog'

const createSessionWorktree = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; branch?: string; name?: string }) => {
      let text = opts?.defaultValue ?? key
      if (opts?.branch) text = text.replace(/\{\{branch\}\}/g, opts.branch)
      if (opts?.name) text = text.replace(/\{\{name\}\}/g, opts.name)
      return text
    },
  }),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../createSessionWorktree', () => ({
  createSessionWorktree: (...args: unknown[]) => createSessionWorktree(...args),
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean
    children: React.ReactNode
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement> & { container?: unknown }) => {
    void rest.container
    return <div data-testid={rest['data-testid']}>{children}</div>
  },
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean
    onCheckedChange: (value: boolean) => void
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
  toast: vi.fn(),
}))

vi.mock('@components/tabcode/components/git-workflow/gitErrorMessage', () => ({
  formatGitErrorForToast: (error: unknown) => (typeof error === 'string' ? error : ''),
}))

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  repoRoot: '/Users/me/project/TabTin',
  currentBranch: 'main',
  branchNames: ['main', 'feat/demo'],
  existingWorktreePaths: ['/Users/me/project/TabTin'],
  defaultBaseBranch: 'main',
  sessionId: 's1',
  spaceId: 'space-1',
  tabScopeKey: 'conversation:s1',
  previousRootPath: '/Users/me/project/TabTin',
  onCreated: vi.fn(),
  onError: vi.fn(),
}

function fillBranch(value: string) {
  fireEvent.change(screen.getByLabelText('分支'), { target: { value } })
}

describe('CreateWorktreeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createSessionWorktree.mockResolvedValue({
      ok: true,
      created: true,
      switched: true,
      rootPath: '/Users/me/project/TabTin-feat-login',
    })
  })

  it('默认不展示绝对路径输入框，只提示将自动生成目录', () => {
    render(<CreateWorktreeDialog {...baseProps} />)
    expect(screen.getByTestId('worktree-location-preview').textContent).toBe(
      '填写分支后将自动生成目录名',
    )
    expect(screen.queryByPlaceholderText('请输入绝对路径')).toBeNull()
    expect(screen.queryByTestId('worktree-folder-name')).toBeNull()
  })

  it('填分支后预览短目录名，提交时带上自动路径', async () => {
    render(<CreateWorktreeDialog {...baseProps} />)
    fillBranch('feat/login')
    expect(screen.getByTestId('worktree-location-preview').textContent).toBe(
      '将创建目录 TabTin-feat-login',
    )

    fireEvent.click(screen.getByTestId('code-workspace-create-and-switch'))
    await waitFor(() => {
      expect(createSessionWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feat/login',
          path: '/Users/me/project/TabTin-feat-login',
          createBranch: true,
        }),
      )
    })
  })

  it('展开改位置后可以改短目录名，且不再被分支覆盖', () => {
    render(<CreateWorktreeDialog {...baseProps} />)
    fillBranch('feat/login')
    fireEvent.click(screen.getByTestId('worktree-change-location'))
    fireEvent.change(screen.getByTestId('worktree-folder-name'), {
      target: { value: 'my-copy' },
    })
    fillBranch('feat/other')
    expect(screen.getByTestId('worktree-folder-name')).toHaveProperty('value', 'my-copy')
  })

  it('submits create-and-switch once while in flight', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined
    createSessionWorktree.mockImplementation(
      () => new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    render(<CreateWorktreeDialog {...baseProps} />)
    fillBranch('feat/login')

    fireEvent.click(screen.getByTestId('code-workspace-create-and-switch'))
    fireEvent.click(screen.getByTestId('code-workspace-create-and-switch'))

    expect(createSessionWorktree).toHaveBeenCalledOnce()
    resolveCreate?.({
      ok: true,
      created: true,
      switched: true,
      rootPath: '/Users/me/project/TabTin-feat-login',
    })
    await waitFor(() => {
      expect(baseProps.onCreated).toHaveBeenCalledWith({
        rootPath: '/Users/me/project/TabTin-feat-login',
        switched: true,
      })
    })
  })

  it('keeps the dialog open when validation fails', async () => {
    createSessionWorktree.mockResolvedValue({
      ok: false,
      phase: 'validate',
      reason: 'path_required',
    })
    render(<CreateWorktreeDialog {...baseProps} />)
    fillBranch('feat/login')
    fireEvent.click(screen.getByTestId('code-workspace-create-and-switch'))
    await waitFor(() => {
      expect(baseProps.onError).toHaveBeenCalled()
    })
    expect(baseProps.onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
