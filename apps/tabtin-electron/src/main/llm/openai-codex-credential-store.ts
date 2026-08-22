import { credentialStore } from '../safe-credential-store.js'
import { TokenManager } from '../auth.js'
import {
  refreshOpenAICodexToken,
  type OpenAICodexOAuthCredential,
} from './openai-codex-oauth.js'
import { notifyOpenAICodexStatusChanged } from './openai-codex-status-events.js'

const SERVICE_NAME = 'tabtin.openai-codex'
const ACCOUNT_NAME = 'default'

type CredentialStoreDependencies = {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (service: string, account: string, value: string) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
  refresh: (refreshToken: string) => Promise<OpenAICodexOAuthCredential>
  resolveAccountName: () => Promise<string | null>
}

export class OpenAICodexCredentialStore {
  private readonly dependencies: CredentialStoreDependencies
  private pending: Promise<void> = Promise.resolve()

  constructor(dependencies: Partial<CredentialStoreDependencies> = {}) {
    this.dependencies = {
      getPassword: dependencies.getPassword ?? credentialStore.getPassword,
      setPassword: dependencies.setPassword ?? credentialStore.setPassword,
      deletePassword: dependencies.deletePassword ?? credentialStore.deletePassword,
      refresh: dependencies.refresh ?? refreshOpenAICodexToken,
      resolveAccountName: dependencies.resolveAccountName ?? (async () => ACCOUNT_NAME),
    }
  }

  async read(): Promise<OpenAICodexOAuthCredential | null> {
    return this.runExclusive(async () => {
      const accountName = await this.dependencies.resolveAccountName()
      if (!accountName) return null
      return this.readStoredCredential(accountName)
    })
  }

  async modify(
    fn: (
      credential: OpenAICodexOAuthCredential | null,
    ) => OpenAICodexOAuthCredential | null | Promise<OpenAICodexOAuthCredential | null>,
  ): Promise<OpenAICodexOAuthCredential | null> {
    return this.runExclusive(async () => {
      const accountName = await this.requireAccountName()
      const next = await fn(await this.readStoredCredential(accountName))
      if (next) {
        await this.write(accountName, next)
      } else {
        await this.dependencies.deletePassword(SERVICE_NAME, accountName)
      }
      return next
    })
  }

  async delete(): Promise<void> {
    await this.runExclusive(async () => {
      const accountName = await this.dependencies.resolveAccountName()
      if (!accountName) return
      await this.dependencies.deletePassword(SERVICE_NAME, accountName)
    })
  }

  async getValidAuth(): Promise<OpenAICodexOAuthCredential | null> {
    return this.runExclusive(async () => {
      const accountName = await this.requireAccountName()
      const credential = await this.readStoredCredential(accountName)
      if (!credential || credential.expires > Date.now()) return credential

      let refreshed: OpenAICodexOAuthCredential
      try {
        refreshed = await this.dependencies.refresh(credential.refresh)
      } catch (error) {
        if (isRejectedRefreshError(error)) {
          await this.dependencies.deletePassword(SERVICE_NAME, accountName)
          await notifyOpenAICodexStatusChanged('disconnected')
        }
        throw error
      }
      await this.write(accountName, refreshed)
      return refreshed
    })
  }

  private async readStoredCredential(accountName: string): Promise<OpenAICodexOAuthCredential | null> {
    let stored = await this.dependencies.getPassword(SERVICE_NAME, accountName)
    // 一次性迁移旧版全设备 `default` 凭据到当前 TabTin 用户桶。迁移后立即删除
    // legacy，避免下一位登录用户再次继承同一份 ChatGPT 额度。
    if (!stored && accountName !== ACCOUNT_NAME) {
      const legacy = await this.dependencies.getPassword(SERVICE_NAME, ACCOUNT_NAME)
      const legacyCredential = parseStoredCredential(legacy)
      if (legacyCredential) {
        await this.write(accountName, legacyCredential)
        await this.dependencies.deletePassword(SERVICE_NAME, ACCOUNT_NAME)
        stored = JSON.stringify(legacyCredential)
      }
    }

    return parseStoredCredential(stored)
  }

  private async requireAccountName(): Promise<string> {
    const accountName = await this.dependencies.resolveAccountName()
    if (!accountName) throw new Error('TabTin authentication is required for ChatGPT Codex')
    return accountName
  }

  private async write(accountName: string, credential: OpenAICodexOAuthCredential): Promise<void> {
    await this.dependencies.setPassword(SERVICE_NAME, accountName, JSON.stringify(credential))
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation)
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function parseStoredCredential(stored: string | null): OpenAICodexOAuthCredential | null {
  if (!stored) return null
  try {
    const credential = JSON.parse(stored) as Partial<OpenAICodexOAuthCredential>
    if (
      credential.type !== 'oauth' ||
      typeof credential.access !== 'string' ||
      typeof credential.refresh !== 'string' ||
      typeof credential.expires !== 'number' ||
      !Number.isFinite(credential.expires) ||
      typeof credential.accountId !== 'string' ||
      credential.accountId.length === 0
    ) {
      return null
    }
    return credential as OpenAICodexOAuthCredential
  } catch {
    return null
  }
}

function isRejectedRefreshError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /invalid_grant|\b(?:400|401|403)\b/i.test(error.message)
}

async function resolveCurrentTabTinAccountName(): Promise<string | null> {
  const userInfo = await TokenManager.getUserInfo() as
    | { id?: unknown; user_id?: unknown; userId?: unknown }
    | null
  const rawUserId = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  const userId = typeof rawUserId === 'string' || typeof rawUserId === 'number'
    ? String(rawUserId).trim()
    : ''
  return userId ? `user:${userId}` : null
}

/** 进程内单例：按 TabTin 用户隔离；IPC / login / runtime 共用同一串行锁。 */
export const sharedOpenAICodexCredentialStore = new OpenAICodexCredentialStore({
  resolveAccountName: resolveCurrentTabTinAccountName,
})
