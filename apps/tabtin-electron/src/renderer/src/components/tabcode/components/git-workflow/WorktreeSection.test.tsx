import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeSection } from './WorktreeSection';

const mocks = vi.hoisted(() => ({
  openProject: vi.fn(),
  closeDialog: vi.fn(),
  switchSessionWorktree: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@components/ui', () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Select: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SelectTrigger: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  toast: mocks.toast,
}));

vi.mock('@utils/cn', () => ({
  cn: (...args: Array<string | false | null | undefined>) =>
    args.filter(Boolean).join(' '),
}));

vi.mock('../TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: () => null,
}));

vi.mock('@stores/useSessionBoundCodeRootStore', () => ({
  useSessionBoundCodeRootStore: () => null,
}));

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
  }),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@components/context-space/code-workspace/switchSessionWorktree', () => ({
  switchSessionWorktree: mocks.switchSessionWorktree,
}));

const baseProps = () => ({
  rootPath: '/repo',
  branchNames: ['main'],
  worktrees: [
    {
      path: '/repo',
      branch: 'main',
      isCurrent: true,
      isDetached: false,
      isLocked: false,
    },
    {
      path: '/repo-feature',
      branch: 'feature/worktree',
      isCurrent: false,
      isDetached: false,
      isLocked: false,
    },
  ],
  currentBranchName: 'main',
  worktreeBaseBranch: 'main',
  setWorktreeBaseBranch: vi.fn(),
  worktreeBranch: 'feature/worktree',
  setWorktreeBranch: vi.fn(),
  actionKey: null,
  runGitAction: vi.fn().mockResolvedValue(true),
  onOpenProjectPath: mocks.openProject,
  onCloseDialog: mocks.closeDialog,
  sessionId: 'session-1',
  spaceId: 'space-1',
  tabScopeKey: 'conversation:session-1',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.switchSessionWorktree.mockResolvedValue({
    success: true,
    rootPath: '/repo-feature',
  });
});

describe('WorktreeSection', () => {
  it('marks the current code directory and only exposes a switch icon for other worktrees', () => {
    render(<WorktreeSection {...baseProps()} />);

    expect(screen.getByText('gitFlow.currentCodeDirectory')).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: 'gitFlow.switchToWorktree' }),
    ).toHaveLength(1);
    expect(screen.getByText('gitFlow.switchToWorktree')).toBeTruthy();
    expect(screen.queryByText('gitFlow.open')).toBeNull();
  });

  it('closes the dialog before opening the target worktree after binding', async () => {
    render(<WorktreeSection {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'gitFlow.switchToWorktree' }),
    );

    await waitFor(() => {
      expect(mocks.closeDialog).toHaveBeenCalledOnce();
      expect(mocks.openProject).toHaveBeenCalledWith('/repo-feature');
    });
    expect(mocks.closeDialog.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openProject.mock.invocationCallOrder[0],
    );
    expect(mocks.switchSessionWorktree).toHaveBeenCalledWith({
      sessionId: 'session-1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:session-1',
      rootPath: '/repo-feature',
      previousRootPath: '/repo',
      branch: 'feature/worktree',
    });
  });

  it('create form hides the absolute path field and shows a folder preview', () => {
    render(<WorktreeSection {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.createWorktree' }));
    expect(screen.getByTestId('worktree-location-preview')).toBeTruthy();
    expect(screen.queryByLabelText('gitFlow.worktreePath')).toBeNull();
    expect(screen.queryByPlaceholderText('gitFlow.worktreePathPlaceholder')).toBeNull();
  });
});
