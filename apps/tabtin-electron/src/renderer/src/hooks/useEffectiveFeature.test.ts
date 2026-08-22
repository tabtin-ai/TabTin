import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@/services/api', () => ({ apiService: { request } }))

import { effectiveFeaturesUrl, readEffectiveFeature, useEffectiveFeature } from './useEffectiveFeature'

describe('readEffectiveFeature', () => {
  beforeEach(() => request.mockReset())
  it('fails closed unless the server explicitly enables the feature', () => {
    expect(readEffectiveFeature(undefined, 'daemon_control')).toEqual({ enabled: false, reason: 'disabled' })
    expect(readEffectiveFeature({ daemon_control: { enabled: false, reason: 'not_in_rollout' } }, 'daemon_control'))
      .toEqual({ enabled: false, reason: 'not_in_rollout' })
    expect(readEffectiveFeature({ daemon_control: { enabled: true, reason: 'enabled' } }, 'daemon_control'))
      .toEqual({ enabled: true, reason: 'enabled' })
  })

  it('uses the selected organization as the effective-feature context', () => {
    expect(effectiveFeaturesUrl('mufan')).toContain('organization_id=mufan')
    expect(effectiveFeaturesUrl('personal')).toContain('organization_id=personal')
  })

  it('closes immediately while a newly selected organization is loading', async () => {
    request.mockResolvedValueOnce({ daemon_control: { enabled: true, reason: 'enabled' } })
    const { result, rerender } = renderHook(
      ({ organizationId }: { organizationId: string }) => useEffectiveFeature('daemon_control', organizationId),
      { initialProps: { organizationId: 'allowed-org' } },
    )
    await waitFor(() => expect(result.current).toEqual({ enabled: true, reason: 'enabled' }))

    let resolveRequest!: (value: Record<string, { enabled: boolean; reason: string }>) => void
    request.mockReturnValueOnce(new Promise(resolve => { resolveRequest = resolve }))
    rerender({ organizationId: 'blocked-org' })

    expect(result.current).toEqual({ enabled: false, reason: 'disabled' })
    expect(request).toHaveBeenLastCalledWith({
      method: 'GET',
      url: '/platform-config/features/effective?organization_id=blocked-org',
    })

    await act(async () => resolveRequest({ daemon_control: { enabled: false, reason: 'not_in_rollout' } }))
    await waitFor(() => expect(result.current).toEqual({ enabled: false, reason: 'not_in_rollout' }))
  })
})
