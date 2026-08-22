import { describe, expect, it, vi } from 'vitest'

import { OPENAI_CODEX_MODELS } from '../openai-codex-models.js'
import { registerOpenAICodexIpc } from '../openai-codex-ipc.js'

describe('registerOpenAICodexIpc', () => {
  it('注册 envelope 形态的状态和设备码登录 IPC', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const registerHandle = vi.fn((channel, handler) =>
      handlers.set(channel, handler),
    )
    const startDeviceCodeLogin = vi.fn().mockResolvedValue({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
    })
    const store = {
      read: vi.fn().mockResolvedValue({
        type: 'oauth',
        access: 'secret-access-token',
        refresh: 'secret-refresh-token',
        expires: 123_456,
        accountId: 'acct_123',
      }),
      modify: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    }

    registerOpenAICodexIpc({
      registerHandle,
      credentialStore: store,
      login: {
        startBrowserLogin: vi.fn(),
        startDeviceCodeLogin,
        cancelLogin: vi.fn(),
      },
    })

    expect([...handlers.keys()]).toEqual([
      'openai-codex:get-status',
      'openai-codex:login-browser',
      'openai-codex:login-device-code',
      'openai-codex:logout',
      'openai-codex:cancel-login',
    ])
    await expect(handlers.get('openai-codex:get-status')!()).resolves.toEqual({
      ok: true,
      data: {
        connected: true,
        expiresAt: 123_456,
        models: OPENAI_CODEX_MODELS.map(({ id, displayName }) => ({ id, displayName })),
      },
    })
    await expect(
      handlers.get('openai-codex:login-device-code')!(),
    ).resolves.toEqual({
      ok: true,
      data: {
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/codex/device',
      },
    })
  })

  it('登出前取消登录并删除本地凭据', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const cancelLogin = vi.fn()
    const deleteCredential = vi.fn().mockResolvedValue(undefined)
    registerOpenAICodexIpc({
      registerHandle: (channel, handler) => handlers.set(channel, handler),
      credentialStore: {
        read: vi.fn(),
        modify: vi.fn(),
        delete: deleteCredential,
      },
      login: {
        startBrowserLogin: vi.fn(),
        startDeviceCodeLogin: vi.fn(),
        cancelLogin,
      },
    })

    await expect(handlers.get('openai-codex:logout')!()).resolves.toEqual({
      ok: true,
      data: { loggedOut: true },
    })

    expect(cancelLogin).toHaveBeenCalledTimes(1)
    expect(deleteCredential).toHaveBeenCalledTimes(1)
  })
})
