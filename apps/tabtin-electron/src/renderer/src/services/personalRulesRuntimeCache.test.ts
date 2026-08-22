import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolvePersonalRulesForRuntime,
  setCachedPersonalRules,
} from './personalRulesRuntimeCache'
import { apiService } from '@/services/api'

vi.mock('@/services/api', () => ({
  apiService: {
    getPersonalRules: vi.fn(),
  },
}))

describe('personalRulesRuntimeCache', () => {
  beforeEach(() => {
    vi.mocked(apiService.getPersonalRules).mockReset()
    setCachedPersonalRules(undefined, 'user-a')
    setCachedPersonalRules(undefined, 'user-b')
  })

  it('uses Agent API personal_rules when the field is present', async () => {
    const rules = await resolvePersonalRulesForRuntime(
      { personal_rules: '  Reply in English  ' },
      'user-a',
    )

    expect(rules).toBe('Reply in English')
    expect(apiService.getPersonalRules).not.toHaveBeenCalled()
  })

  it('falls back to the personal-rules API when an older server omits the Agent field', async () => {
    vi.mocked(apiService.getPersonalRules).mockResolvedValue({ personal_rules: 'Reply in English' })

    const rules = await resolvePersonalRulesForRuntime({}, 'user-a')

    expect(rules).toBe('Reply in English')
    expect(apiService.getPersonalRules).toHaveBeenCalledTimes(1)
  })

  it('reuses the saved local cache before hitting the API', async () => {
    setCachedPersonalRules('Reply in English', 'user-a')

    const rules = await resolvePersonalRulesForRuntime({}, 'user-a')

    expect(rules).toBe('Reply in English')
    expect(apiService.getPersonalRules).not.toHaveBeenCalled()
  })

  it('does not leak cached rules across users', async () => {
    setCachedPersonalRules('User A rule', 'user-a')
    vi.mocked(apiService.getPersonalRules).mockResolvedValue({ personal_rules: 'User B rule' })

    const rules = await resolvePersonalRulesForRuntime({}, 'user-b')

    expect(rules).toBe('User B rule')
    expect(apiService.getPersonalRules).toHaveBeenCalledTimes(1)
  })

  it('caches an explicitly empty rules response', async () => {
    vi.mocked(apiService.getPersonalRules).mockResolvedValue({ personal_rules: '' })

    await expect(resolvePersonalRulesForRuntime({}, 'user-a')).resolves.toBeUndefined()
    await expect(resolvePersonalRulesForRuntime({}, 'user-a')).resolves.toBeUndefined()

    expect(apiService.getPersonalRules).toHaveBeenCalledTimes(1)
  })

  it('can disable current-user API fallback for agents owned by someone else', async () => {
    vi.mocked(apiService.getPersonalRules).mockResolvedValue({ personal_rules: 'Current user rule' })

    const rules = await resolvePersonalRulesForRuntime(
      {},
      'other-owner',
      { allowApiFallback: false },
    )

    expect(rules).toBeUndefined()
    expect(apiService.getPersonalRules).not.toHaveBeenCalled()
  })
})
