import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDirAutoPane } from './LocalDirAutoPane'
import { useGitFlowPreference } from '@stores/useGitFlowPreference'

const mocks = vi.hoisted(() => ({
  appendSessionAllowedPath: vi.fn(),
  isGitRepo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('./FileExplorerPane', () => ({
  FileExplorerPane: ({
    gitFlowSwitch,
  }: {
    gitFlowSwitch?: { onChange: (checked: boolean) => void }
  }) => (
    <div data-testid="file-explorer">
      {gitFlowSwitch ? (
        <button type="button" onClick={() => gitFlowSwitch.onChange(true)}>
          enable-git-flow
        </button>
      ) : null}
    </div>
  ),
}))

vi.mock('@components/tabcode/TabCodePaneHost', () => ({
  TabCodePaneHost: ({
    gitFlowSwitch,
    assumeGitRepo,
    isPaneActive,
  }: {
    gitFlowSwitch?: { onChange: (checked: boolean) => void }
    assumeGitRepo?: boolean
    isPaneActive?: boolean
  }) => (
    <div
      data-testid="tabcode-pane"
      data-assume-git-repo={assumeGitRepo ? 'true' : 'false'}
      data-pane-active={String(isPaneActive ?? true)}
    >
      {gitFlowSwitch ? (
        <button type="button" onClick={() => gitFlowSwitch.onChange(false)}>
          disable-git-flow
        </button>
      ) : null}
    </div>
  ),
}))

vi.mock('@/services/ipc-error', () => ({
  formatIpcErrorForUser: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}))

vi.mock('@/utils/logger', () => {
  const api = {
    error: mocks.logError,
    warn: mocks.logWarn,
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }
  return {
    createLogger: () => api,
    logger: api,
  }
})

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      closeTab: vi.fn(),
      openResourceTab: vi.fn(),
    }),
  },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

vi.mock('./useFolderStore', () => ({
  useFolderContextStore: {
    getState: () => ({
      relocateUserFolder: vi.fn(),
    }),
  },
}))

vi.mock('./useLocalDirRootHealth', () => ({
  useLocalDirRootHealth: () => ({
    status: 'ok',
    retry: vi.fn(),
    markMissing: vi.fn(),
  }),
}))

vi.mock('./LocalDirPathMissing', () => ({
  LocalDirPathMissing: () => <div data-testid="path-missing" />,
}))

function installTabTinApi(options?: { withAuthorization?: boolean }) {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      workspace: options?.withAuthorization === false
        ? {}
        : { appendSessionAllowedPath: mocks.appendSessionAllowedPath },
      git: { isGitRepo: mocks.isGitRepo },
    },
  })
}

function renderUserDirectory() {
  return render(
    <LocalDirAutoPane
      rootPath={'C:\\workspace\\TabTin-feature\\TabTin'}
      title="TabTin"
      spaceId="space-1"
      resourceId="user-folder"
      kind="user"
      requiresSessionAuthorization
    />,
  )
}

describe('LocalDirAutoPane session authorization gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGitFlowPreference.setState({ hiddenByPath: {} })
    mocks.appendSessionAllowedPath.mockResolvedValue({ ok: true, data: { mutated: true } })
    mocks.isGitRepo.mockResolvedValue({ success: true, isRepo: false })
    installTabTinApi()
  })

  it('does not mount file access until session authorization completes', async () => {
    let finishAuthorization: (() => void) | undefined
    mocks.appendSessionAllowedPath.mockReturnValueOnce(new Promise<void>((resolve) => {
      finishAuthorization = resolve
    }))

    renderUserDirectory()

    expect(mocks.appendSessionAllowedPath).toHaveBeenCalledWith({
      spaceId: 'space-1',
      path: 'C:\\workspace\\TabTin-feature\\TabTin',
    })
    expect(mocks.isGitRepo).not.toHaveBeenCalled()
    expect(screen.queryByTestId('file-explorer')).toBeNull()

    finishAuthorization?.()

    await waitFor(() => {
      expect(mocks.isGitRepo).toHaveBeenCalledWith('C:\\workspace\\TabTin-feature\\TabTin')
      expect(screen.getByTestId('file-explorer')).toBeTruthy()
    })
  })

  it('shows a retry state and keeps file access unmounted when authorization fails', async () => {
    mocks.appendSessionAllowedPath
      .mockRejectedValueOnce(new Error('authorization failed'))
      .mockResolvedValueOnce({ ok: true, data: { mutated: true } })

    renderUserDirectory()

    const retry = await screen.findByRole('button', { name: '重试' })
    expect(screen.getByText('authorization failed')).toBeTruthy()
    expect(mocks.isGitRepo).not.toHaveBeenCalled()
    expect(screen.queryByTestId('file-explorer')).toBeNull()

    fireEvent.click(retry)

    await waitFor(() => {
      expect(mocks.appendSessionAllowedPath).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('file-explorer')).toBeTruthy()
    })
  })

  it('does not continue mounting a stale directory after the pane unmounts', async () => {
    let finishAuthorization: (() => void) | undefined
    mocks.appendSessionAllowedPath.mockReturnValueOnce(new Promise<void>((resolve) => {
      finishAuthorization = resolve
    }))

    const { unmount } = renderUserDirectory()
    unmount()

    await act(async () => {
      finishAuthorization?.()
    })

    expect(mocks.isGitRepo).not.toHaveBeenCalled()
  })

  it('closes the gate synchronously when the Space or directory identity changes', async () => {
    const { rerender } = renderUserDirectory()

    await waitFor(() => {
      expect(screen.getByTestId('file-explorer')).toBeTruthy()
    })

    let finishNextAuthorization: (() => void) | undefined
    mocks.appendSessionAllowedPath.mockReturnValueOnce(new Promise<void>((resolve) => {
      finishNextAuthorization = resolve
    }))
    mocks.isGitRepo.mockClear()

    rerender(
      <LocalDirAutoPane
        rootPath={'D:\\another-project'}
        title="another-project"
        spaceId="space-2"
        resourceId="another-folder"
        kind="user"
        requiresSessionAuthorization
      />,
    )

    expect(screen.queryByTestId('file-explorer')).toBeNull()
    expect(mocks.isGitRepo).not.toHaveBeenCalled()

    finishNextAuthorization?.()

    await waitFor(() => {
      expect(mocks.isGitRepo).toHaveBeenCalledWith('D:\\another-project')
      expect(screen.getByTestId('file-explorer')).toBeTruthy()
    })
  })

  it('keeps non-authorized callers compatible when the preload bridge is unavailable', async () => {
    installTabTinApi({ withAuthorization: false })

    renderUserDirectory()

    await waitFor(() => {
      expect(screen.getByTestId('file-explorer')).toBeTruthy()
    })
    expect(mocks.appendSessionAllowedPath).not.toHaveBeenCalled()
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'session directory authorization bridge unavailable; using existing path policy',
      { spaceId: 'space-1' },
    )
  })

  it('lets the Git flow switch override a code workspace in both directions', async () => {
    render(
      <LocalDirAutoPane
        rootPath="/workspace/repo"
        title="repo"
        spaceId="space-1"
        kind="user"
        preferredView="code"
      />,
    )

    expect(await screen.findByTestId('tabcode-pane')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'disable-git-flow' }))

    expect(await screen.findByTestId('file-explorer')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'enable-git-flow' }))

    const tabCodePane = await screen.findByTestId('tabcode-pane')
    expect(tabCodePane).toBeTruthy()
    expect(tabCodePane.getAttribute('data-assume-git-repo')).toBe('true')
  })

  it('透传外层 Context 标签的激活状态到内嵌 TabCode', async () => {
    render(
      <LocalDirAutoPane
        rootPath="/workspace/repo"
        title="repo"
        spaceId="space-1"
        kind="user"
        preferredView="code"
        isPaneActive={false}
      />,
    )

    const tabCodePane = await screen.findByTestId('tabcode-pane')
    expect(tabCodePane.getAttribute('data-pane-active')).toBe('false')
  })
})
