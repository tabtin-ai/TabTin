import { describe, expect, it, vi } from 'vitest'
import {
  PENDING_SHARE_INTENTS_STORAGE_KEY,
  buildSessionShareIntentKey,
  forgetPendingShareIntent,
  forgetPendingShareIntentForShare,
  loadPendingShareIntents,
  rememberPendingShareIntent,
  resolvePendingShareClientRequestId,
} from './sessionSharePendingIntent'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size },
    clear() { map.clear() },
    getItem(key: string) { return map.has(key) ? map.get(key)! : null },
    key(index: number) { return Array.from(map.keys())[index] ?? null },
    removeItem(key: string) { map.delete(key) },
    setItem(key: string, value: string) { map.set(key, value) },
  }
}

describe('sessionSharePendingIntent', () => {
  it('reuses stored client_request_id for the same intent key', () => {
    const storage = memoryStorage()
    const intentKey = buildSessionShareIntentKey({
      organizationId: 'org-1',
      sessionId: 'sess-1',
      granteeUserId: 'user-2',
      tier: 'view',
    })
    rememberPendingShareIntent(intentKey, '019fc711-ab26-7924-bc0a-1b115740aca0', storage)
    const resolved = resolvePendingShareClientRequestId({
      intentKey,
      memoryIntent: null,
      createId: () => 'should-not-create',
      storage,
    })
    expect(resolved).toBe('019fc711-ab26-7924-bc0a-1b115740aca0')
    expect(loadPendingShareIntents(storage)[intentKey]?.clientRequestId).toBe(resolved)
  })

  it('forgets intent after success so the next share gets a new id', () => {
    const storage = memoryStorage()
    const intentKey = buildSessionShareIntentKey({
      organizationId: 'org-1',
      sessionId: 'sess-1',
      granteeUserId: 'user-2',
      tier: 'view',
    })
    rememberPendingShareIntent(intentKey, '019fc711-ab26-7924-bc0a-1b115740aca1', storage)
    forgetPendingShareIntent(intentKey, storage)
    expect(storage.getItem(PENDING_SHARE_INTENTS_STORAGE_KEY)).toBeNull()
    const resolved = resolvePendingShareClientRequestId({
      intentKey,
      memoryIntent: null,
      createId: () => '019fc711-ab26-7924-bc0a-1b115740aca2',
      storage,
    })
    expect(resolved).toBe('019fc711-ab26-7924-bc0a-1b115740aca2')
  })

  it('uses the same key across entry points and keeps it until explicit success', () => {
    const storage = memoryStorage()
    const intentKey = buildSessionShareIntentKey({
      organizationId: 'org-1',
      sessionId: 'sess-1',
      granteeUserId: 'user-2',
      tier: 'view',
    })
    rememberPendingShareIntent(intentKey, '019fc711-ab26-7924-bc0a-1b115740aca3', storage)

    vi.setSystemTime(new Date('2036-08-07T00:00:00Z'))
    expect(loadPendingShareIntents(storage)[intentKey]?.clientRequestId)
      .toBe('019fc711-ab26-7924-bc0a-1b115740aca3')
    expect(intentKey).not.toContain('conversation-1')
    vi.useRealTimers()
  })

  it('forgets the cancelled pending share so resharing gets a new id', () => {
    const storage = memoryStorage()
    const intentKey = buildSessionShareIntentKey({
      organizationId: 'org-1',
      sessionId: 'sess-1',
      granteeUserId: 'user-2',
      tier: 'fork',
    })
    rememberPendingShareIntent(
      intentKey,
      '019fc711-ab26-7924-bc0a-1b115740aca4',
      storage,
    )

    forgetPendingShareIntentForShare({
      sessionId: 'sess-1',
      granteeUserId: 'user-2',
      tier: 'fork',
    }, storage)

    expect(resolvePendingShareClientRequestId({
      intentKey,
      memoryIntent: null,
      createId: () => '019fc711-ab26-7924-bc0a-1b115740aca5',
      storage,
    })).toBe('019fc711-ab26-7924-bc0a-1b115740aca5')
  })
})
