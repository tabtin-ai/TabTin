import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => ({
  bindPendingDiagnosticOrganization: vi.fn(),
  getPendingDiagnosticBundles: vi.fn(),
  linkDiagnosticServerBundle: vi.fn(),
  markDiagnosticUploadFailure: vi.fn(),
  removeUploadedDiagnosticBundle: vi.fn(),
}))

vi.mock('../diagnostic-runtime', () => runtimeMocks)
vi.mock('../../auth', () => ({
  TokenManager: { getAccessToken: vi.fn().mockResolvedValue('token') },
}))
vi.mock('../../config/api', () => ({ API_BASE_URL: 'https://api.example' }))
vi.mock('../../cli/cli-context', () => ({ getCLIOrganizationId: vi.fn(() => 'org-1') }))
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn().mockResolvedValue(Buffer.from('zip')) },
}))

import { flushPendingDiagnosticBundles } from '../diagnostic-uploader'

const pendingEntry = {
  bundle_id: 'local-bundle',
  created_at: '2026-08-07T00:00:00.000Z',
  severity: 'fatal' as const,
  error_category: 'CLIENT_CRASH',
  error_code: 'TEST_CRASH',
  release: '1.0.0',
  organization_id: 'org-1',
  client_install_id: 'install-1',
  sentry_event_id: 'event-1',
  status: 'pending' as const,
  attempt_count: 0,
  next_attempt_at: null,
  bundle_path: 'C:/diagnostics/local-bundle.zip',
  bytes: 3,
  expected_sha256: 'a'.repeat(64),
}

describe('diagnostic uploader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.getPendingDiagnosticBundles.mockResolvedValue([pendingEntry])
    runtimeMocks.bindPendingDiagnosticOrganization.mockResolvedValue(undefined)
    runtimeMocks.linkDiagnosticServerBundle.mockResolvedValue(undefined)
    runtimeMocks.markDiagnosticUploadFailure.mockResolvedValue(undefined)
    runtimeMocks.removeUploadedDiagnosticBundle.mockResolvedValue(undefined)
  })

  it('shares one active flush across overlapping timer ticks', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bundle_id: 'server-bundle', upload_url: 'https://oss.example/upload' }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const first = flushPendingDiagnosticBundles()
    const second = flushPendingDiagnosticBundles()
    await Promise.all([first, second])

    expect(first).toBe(second)
    expect(runtimeMocks.bindPendingDiagnosticOrganization).toHaveBeenCalledWith('org-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(runtimeMocks.linkDiagnosticServerBundle).toHaveBeenCalledWith(
      'local-bundle',
      'server-bundle',
    )
    expect(runtimeMocks.removeUploadedDiagnosticBundle).toHaveBeenCalledOnce()
  })

  it('reuses a persisted server bundle when completion is retried', async () => {
    runtimeMocks.getPendingDiagnosticBundles.mockResolvedValue([{
      ...pendingEntry,
      server_bundle_id: 'server-bundle',
    }])
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await flushPendingDiagnosticBundles()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/diagnostics/bundles/server-bundle/complete',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(runtimeMocks.linkDiagnosticServerBundle).not.toHaveBeenCalled()
  })
})
