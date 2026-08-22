import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskUserRequestStateChoice } from '@stores/chat/shared/types'

const mocks = vi.hoisted(() => ({
  useIsRemoteViewer: vi.fn(),
  toast: vi.fn(),
  openLoginRelayWorkbenchTab: vi.fn(),
  closeLoginRelayWorkbenchTab: vi.fn(),
  resolveForegroundTabScopeKey: vi.fn(),
}))
const loginRelay = {
  start: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      const fallback = typeof options === 'string' ? options : options?.defaultValue
      if (typeof fallback !== 'string') return key
      const values = typeof options === 'string' ? {} : (options ?? {})
      return fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ''))
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  toast: mocks.toast,
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  toast: mocks.toast,
}))

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: mocks.useIsRemoteViewer,
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } | null }) => unknown) => selector({
    selectedOrganization: { id: 'org-1' },
  }),
}))

vi.mock('@/services/loginRelayWorkbench', () => ({
  openLoginRelayWorkbenchTab: (...args: unknown[]) => mocks.openLoginRelayWorkbenchTab(...args),
  closeLoginRelayWorkbenchTab: (...args: unknown[]) => mocks.closeLoginRelayWorkbenchTab(...args),
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (...args: unknown[]) => mocks.resolveForegroundTabScopeKey(...args),
}))

vi.mock('../../composer-presets/SchemaFormRenderer', () => ({
  SchemaFormRenderer: () => null,
}))

const baseState: AskUserRequestStateChoice = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  toolCallId: 'tool-1',
  kind: 'choice',
  title: '需要登录',
  questions: [{
    id: 'question-1',
    prompt: '请选择下一步',
    options: [{ id: 'manual', label: '手动登录' }],
  }],
}

function loginWallState(): AskUserRequestStateChoice {
  return {
    ...baseState,
    contextHint: { kind: 'login_wall', domain: 'example.com', tabId: 'view-login-wall' },
  }
}

async function renderLoginRelay(onChoiceSubmit = vi.fn(), onSkip = vi.fn()) {
  const { AskUserPanel } = await import('../AskUserPanel')
  return {
    ...render(
      <AskUserPanel
        state={loginWallState()}
        spaceId="space-1"
        onChoiceSubmit={onChoiceSubmit}
        onSkip={onSkip}
      />,
    ),
    onChoiceSubmit,
    onSkip,
  }
}

function sharedLoginStart(relayId: string) {
  return {
    success: true,
    relayId,
    partition: 'persist:tabtin:organization:org-1:browser',
    loginUrl: 'https://example.com/',
  }
}

async function startLocalLogin() {
  fireEvent.click(await screen.findByRole('button', { name: '在本机登录并接力' }))
  await screen.findByRole('button', { name: '我已登录，发送给执行设备' })
}

describe('LoginRelayAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useIsRemoteViewer.mockReturnValue({
      isRemoteViewer: true,
      isResolving: false,
      controlDeviceName: '执行设备 B',
      controlDeviceId: 'device-b',
      workingDir: '/workspace',
    })
    mocks.resolveForegroundTabScopeKey.mockReturnValue('conversation:thread-1')
    mocks.closeLoginRelayWorkbenchTab.mockResolvedValue(undefined)
    mocks.openLoginRelayWorkbenchTab.mockResolvedValue({
      ok: true,
      handle: {
        crawlspaceId: 'cs-login-relay-default',
        viewId: 'view-login-relay-default',
        tabScopeKey: 'conversation:thread-1',
        tabKey: 'login_relay:view-login-relay-default',
      },
    })
    Object.assign(window.tabtin, { loginRelay })
  })

  it('shows only the relay action on remote viewer A', async () => {
    await renderLoginRelay()
    expect(await screen.findByRole('button', { name: '在本机登录并接力' })).toBeTruthy()
    expect(screen.getByText(
      '远程页面需要登录后才能继续。你可以在本机完成登录，再将登录状态接力到执行设备。',
    )).toBeTruthy()
    expect(screen.queryByTestId('ask-user-choice-panel')).toBeNull()
  })

  it('skips the original login question when remote viewer A chooses not to log in', async () => {
    const onSkip = vi.fn()
    await renderLoginRelay(vi.fn(), onSkip)

    fireEvent.click(await screen.findByRole('button', { name: '暂不登录' }))

    expect(onSkip).toHaveBeenCalledOnce()
    expect(loginRelay.start).not.toHaveBeenCalled()
  })

  it('shows only the original login choices on control device B', async () => {
    mocks.useIsRemoteViewer.mockReturnValue({
      isRemoteViewer: false,
      isResolving: false,
      controlDeviceName: '执行设备 B',
      controlDeviceId: 'device-b',
      workingDir: '/workspace',
    })
    await renderLoginRelay()

    expect(await screen.findByTestId('ask-user-choice-panel')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '在本机登录并接力' })).toBeNull()
    expect(screen.queryByText(
      '远程页面需要登录后才能继续。你可以在本机完成登录，再将登录状态接力到执行设备。',
    )).toBeNull()
  })

  it('shows neither login action while device ownership is resolving', async () => {
    mocks.useIsRemoteViewer.mockReturnValue({
      isRemoteViewer: false,
      isResolving: true,
      controlDeviceName: null,
      controlDeviceId: null,
      workingDir: null,
    })
    await renderLoginRelay()

    expect(screen.queryByTestId('ask-user-choice-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: '在本机登录并接力' })).toBeNull()
  })

  it('does not render for a normal ask_user card without a login-wall hint', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')
    render(<AskUserPanel state={baseState} spaceId="space-1" onChoiceSubmit={vi.fn()} />)
    expect(mocks.useIsRemoteViewer).not.toHaveBeenCalled()
  })

  it('opens the shared local site page immediately without asking the user to choose an account', async () => {
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-1'))
    await renderLoginRelay()
    fireEvent.click(await screen.findByRole('button', { name: '在本机登录并接力' }))

    expect(await screen.findByRole('button', { name: '我已登录，发送给执行设备' })).toBeTruthy()
    expect(screen.getByText('已在右侧工作台打开 example.com；确认已登录后再发送。')).toBeTruthy()
    expect(loginRelay.start).toHaveBeenCalledWith({
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'example.com',
    })
    expect(mocks.openLoginRelayWorkbenchTab).toHaveBeenCalledWith({
      tabScopeKey: 'conversation:thread-1',
      relayId: 'relay-1',
      organizationId: 'org-1',
      partition: 'persist:tabtin:organization:org-1:browser',
      loginUrl: 'https://example.com/',
      domain: 'example.com',
    })
    expect(loginRelay.complete).not.toHaveBeenCalled()
  })

  it('cancels the relay if opening the local site page fails', async () => {
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-open-failed'))
    mocks.openLoginRelayWorkbenchTab.mockResolvedValue({
      ok: false,
      error: '无法打开登录页面',
    })
    loginRelay.cancel.mockResolvedValue({ success: true })
    await renderLoginRelay()
    fireEvent.click(await screen.findByRole('button', { name: '在本机登录并接力' }))

    expect((await screen.findByRole('alert')).textContent).toContain('无法打开登录页面')
    expect(loginRelay.cancel).toHaveBeenCalledWith({ relayId: 'relay-open-failed' })
  })

  it('cancels both the relay and local site page when the user cancels', async () => {
    const handle = {
      crawlspaceId: 'cs-login-relay-relay-cancel',
      viewId: 'view-login-relay-relay-cancel',
      tabScopeKey: 'conversation:thread-1',
      tabKey: 'login_relay:view-login-relay-relay-cancel',
    }
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-cancel'))
    mocks.openLoginRelayWorkbenchTab.mockResolvedValue({ ok: true, handle })
    loginRelay.cancel.mockResolvedValue({ success: true })
    await renderLoginRelay()
    await startLocalLogin()
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(loginRelay.cancel).toHaveBeenCalledWith({ relayId: 'relay-cancel' })
      expect(mocks.closeLoginRelayWorkbenchTab).toHaveBeenCalledWith(handle)
    })
  })

  it('cleans up a waiting relay and local site page when the card unmounts', async () => {
    const handle = {
      crawlspaceId: 'cs-login-relay-relay-unmount',
      viewId: 'view-login-relay-relay-unmount',
      tabScopeKey: 'conversation:thread-1',
      tabKey: 'login_relay:view-login-relay-relay-unmount',
    }
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-unmount'))
    mocks.openLoginRelayWorkbenchTab.mockResolvedValue({ ok: true, handle })
    loginRelay.cancel.mockResolvedValue({ success: true })
    const view = await renderLoginRelay()
    await startLocalLogin()

    view.unmount()
    await waitFor(() => {
      expect(loginRelay.cancel).toHaveBeenCalledWith({ relayId: 'relay-unmount' })
      expect(mocks.closeLoginRelayWorkbenchTab).toHaveBeenCalledWith(handle)
    })
  })

  it('automatically answers the original card only after the execution tab reloads', async () => {
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-success'))
    loginRelay.complete.mockResolvedValue({
      success: true,
      packageId: 'package-1',
      importResult: { success: true, imported_count: 1, reloaded: true },
    })
    const onChoiceSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')
    const RelayCompletionHarness = () => {
      const [isPending, setIsPending] = React.useState(true)
      return isPending ? (
        <AskUserPanel
          state={loginWallState()}
          spaceId="space-1"
          onChoiceSubmit={answers => {
            onChoiceSubmit(answers)
            setIsPending(false)
          }}
        />
      ) : null
    }
    render(<RelayCompletionHarness />)
    await startLocalLogin()
    fireEvent.click(screen.getByRole('button', { name: '我已登录，发送给执行设备' }))

    await waitFor(() => expect(onChoiceSubmit).toHaveBeenCalledWith([
      {
        question_id: 'question-1',
        selected_options: ['__other__'],
        free_text: '登录态已同步至执行设备，原页面已刷新，请继续原任务。',
      },
    ]))
    expect(mocks.toast).toHaveBeenCalledWith({
      title: '登录态已同步，执行设备页面已刷新。',
    })
    expect(mocks.closeLoginRelayWorkbenchTab).toHaveBeenCalledWith(expect.objectContaining({
      crawlspaceId: 'cs-login-relay-default',
    }))
    expect(screen.queryByTestId('ask-user-choice-panel')).toBeNull()
  })

  it('keeps the card pending when the execution device imports cookies but does not confirm a reload', async () => {
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-no-reload'))
    loginRelay.complete.mockResolvedValue({
      success: true,
      packageId: 'package-1',
      importResult: { success: true, imported_count: 1, reloaded: false },
    })
    loginRelay.cancel.mockResolvedValue({ success: true })
    const onChoiceSubmit = vi.fn()

    await renderLoginRelay(onChoiceSubmit)
    await startLocalLogin()
    fireEvent.click(screen.getByRole('button', { name: '我已登录，发送给执行设备' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('执行设备未能刷新登录页面')
    expect(onChoiceSubmit).not.toHaveBeenCalled()
  })

  it('shows the execution-device diagnostic when cookie import fails', async () => {
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-import-failed'))
    loginRelay.complete.mockResolvedValue({
      success: true,
      packageId: 'package-1',
      importResult: {
        success: false,
        error: 'import_failed',
        error_code: 'cookie_write_failed',
      },
    })
    loginRelay.cancel.mockResolvedValue({ success: true })

    await renderLoginRelay()
    await startLocalLogin()
    fireEvent.click(screen.getByRole('button', { name: '我已登录，发送给执行设备' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('执行设备写入登录信息失败')
  })

  it('does not expose an internal import_failed code to the user', async () => {
    loginRelay.start.mockResolvedValue(sharedLoginStart('relay-safe-error'))
    loginRelay.complete.mockResolvedValue({
      success: false,
      error: 'import_failed',
      importResult: {
        success: false,
        error: 'import_failed',
        error_code: 'target_tab_unavailable',
      },
    })
    loginRelay.cancel.mockResolvedValue({ success: true })

    await renderLoginRelay()
    await startLocalLogin()
    fireEvent.click(screen.getByRole('button', { name: '我已登录，发送给执行设备' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('执行设备未能刷新登录页面')
    expect(alert.textContent).not.toContain('import_failed')
  })
})
