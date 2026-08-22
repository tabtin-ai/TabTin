import { describe, expect, it, vi } from 'vitest'

import { OpenAICodexCredentialStore } from '../openai-codex-credential-store.js'
import type { OpenAICodexOAuthCredential } from '../openai-codex-oauth.js'

const expiredCredential: OpenAICodexOAuthCredential = {
  type: 'oauth',
  access: 'expired-access',
  refresh: 'refresh-token',
  expires: Date.now() - 1,
  accountId: 'acct_123',
}

function createDependencies(initial: OpenAICodexOAuthCredential | null) {
  let stored = initial ? JSON.stringify(initial) : null
  return {
    getPassword: vi.fn(async () => stored),
    setPassword: vi.fn(async (_service: string, _account: string, value: string) => {
      stored = value
    }),
    deletePassword: vi.fn(async () => {
      stored = null
      return true
    }),
    refresh: vi.fn(async () => ({
      ...expiredCredential,
      access: 'fresh-access',
      refresh: 'rotated-refresh-token',
      expires: Date.now() + 60_000,
    })),
  }
}

describe('OpenAICodexCredentialStore', () => {
  it('没有已保存凭据时返回 null', async () => {
    const deps = createDependencies(null)
    const store = new OpenAICodexCredentialStore(deps)

    await expect(store.read()).resolves.toBeNull()
  })

  it('并发获取过期凭据时只刷新一次并持久化刷新结果', async () => {
    const deps = createDependencies(expiredCredential)
    const store = new OpenAICodexCredentialStore(deps)

    const [first, second] = await Promise.all([store.getValidAuth(), store.getValidAuth()])

    expect(deps.refresh).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ access: 'fresh-access', accountId: 'acct_123' })
    expect(second).toMatchObject({ access: 'fresh-access', accountId: 'acct_123' })
    expect(deps.setPassword).toHaveBeenCalledTimes(1)
    expect(deps.setPassword).toHaveBeenCalledWith(
      'tabtin.openai-codex',
      'default',
      expect.stringContaining('"access":"fresh-access"'),
    )
  })

  it('refresh 被拒绝时删除失效凭据', async () => {
    const deps = createDependencies(expiredCredential)
    deps.refresh.mockRejectedValueOnce(new Error('invalid_grant'))
    const store = new OpenAICodexCredentialStore(deps)

    await expect(store.getValidAuth()).rejects.toThrow('invalid_grant')

    expect(deps.deletePassword).toHaveBeenCalledWith('tabtin.openai-codex', 'default')
  })

  it('串行 modify，后一个修改读取前一个修改的结果', async () => {
    const deps = createDependencies(null)
    const store = new OpenAICodexCredentialStore(deps)
    const first: OpenAICodexOAuthCredential = {
      ...expiredCredential,
      access: 'first-access',
      expires: Date.now() + 60_000,
    }

    await Promise.all([
      store.modify(async () => first),
      store.modify(async (current) => ({ ...current!, access: 'second-access' })),
    ])

    await expect(store.read()).resolves.toMatchObject({ access: 'second-access' })
  })

  it('按 TabTin 用户隔离 ChatGPT 凭据', async () => {
    const passwords = new Map<string, string>()
    let currentAccount = 'user:user-a'
    const store = new OpenAICodexCredentialStore({
      getPassword: vi.fn(async (_service, account) => passwords.get(account) ?? null),
      setPassword: vi.fn(async (_service, account, value) => { passwords.set(account, value) }),
      deletePassword: vi.fn(async (_service, account) => passwords.delete(account)),
      refresh: vi.fn(),
      resolveAccountName: async () => currentAccount,
    })

    await store.modify(() => ({
      ...expiredCredential,
      access: 'user-a-access',
      expires: Date.now() + 60_000,
    }))
    currentAccount = 'user:user-b'
    await expect(store.read()).resolves.toBeNull()

    currentAccount = 'user:user-a'
    await expect(store.read()).resolves.toMatchObject({ access: 'user-a-access' })
  })

  it('旧 default 凭据只迁移给首个当前用户并删除 legacy', async () => {
    const passwords = new Map<string, string>([['default', JSON.stringify(expiredCredential)]])
    const store = new OpenAICodexCredentialStore({
      getPassword: vi.fn(async (_service, account) => passwords.get(account) ?? null),
      setPassword: vi.fn(async (_service, account, value) => { passwords.set(account, value) }),
      deletePassword: vi.fn(async (_service, account) => passwords.delete(account)),
      refresh: vi.fn(),
      resolveAccountName: async () => 'user:user-a',
    })

    await expect(store.read()).resolves.toMatchObject({ accountId: 'acct_123' })
    expect(passwords.has('default')).toBe(false)
    expect(passwords.has('user:user-a')).toBe(true)
  })
})
