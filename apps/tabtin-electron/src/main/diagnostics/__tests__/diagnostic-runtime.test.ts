import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getVersion: () => '1.2.3',
  },
}))

import {
  __testing,
  bindPendingDiagnosticOrganization,
  diagnosticRuntimeLimits,
  getPendingDiagnosticBundles,
  linkDiagnosticServerBundle,
  markDiagnosticUploadFailure,
  recordDiagnosticBreadcrumb,
} from '../diagnostic-runtime'

describe('diagnostic runtime', () => {
  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tabtin-diagnostic-runtime-'))
  })

  afterEach(async () => {
    if (path.basename(userDataDir).startsWith('tabtin-diagnostic-runtime-')) {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('writes a minimal ZIP and pending metadata without raw error content', async () => {
    recordDiagnosticBreadcrumb({ category: 'ipc', code: 'IPC_REJECT', outcome: 'failed' })
    await __testing.persistSnapshot({
      bundleId: 'bundle-1',
      severity: 'fatal',
      errorCategory: 'IPC_FATAL',
      errorCode: 'IPC_CORE_UNAVAILABLE',
      handledBy: 'test',
      organizationId: 'org-1',
      clientInstallId: 'install-1',
    })

    const [entry] = await __testing.readPendingMetadata()
    expect(entry).toMatchObject({ bundle_id: 'bundle-1', status: 'pending', release: '1.2.3' })
    const zip = await JSZip.loadAsync(await fsp.readFile(entry!.bundle_path))
    expect(JSON.parse(await zip.file('meta.json')!.async('string'))).toMatchObject({
      diagnostic_bundle_id: 'bundle-1',
      error_code: 'IPC_CORE_UNAVAILABLE',
    })
    expect(await zip.file('breadcrumbs.json')!.async('string')).not.toContain('Authorization')
  })

  it('stops retrying after the finite retry schedule is exhausted', async () => {
    await __testing.persistSnapshot({
      bundleId: 'bundle-retry',
      severity: 'crash',
      errorCategory: 'CLIENT_CRASH',
      errorCode: 'TEST_CRASH',
      handledBy: 'test',
      organizationId: 'org-1',
      clientInstallId: 'install-1',
    })
    for (let index = 0; index < diagnosticRuntimeLimits.retryDelaysMs.length; index += 1) {
      await markDiagnosticUploadFailure('bundle-retry')
    }
    const [entry] = await __testing.readPendingMetadata()
    expect(entry).toMatchObject({ status: 'failed', next_attempt_at: null })
  })

  it('persists the server bundle id without persisting a signed URL', async () => {
    await __testing.persistSnapshot({
      bundleId: 'bundle-server-link',
      severity: 'fatal',
      errorCategory: 'CLIENT_CRASH',
      errorCode: 'SERVER_LINK',
      handledBy: 'test',
      organizationId: 'org-1',
      clientInstallId: 'install-1',
    })

    await linkDiagnosticServerBundle('bundle-server-link', 'server-bundle-1')

    const [entry] = await __testing.readPendingMetadata()
    expect(entry).toMatchObject({ server_bundle_id: 'server-bundle-1' })
    expect(JSON.stringify(entry)).not.toContain('https://')
  })

  it('binds diagnostics captured before organization context becomes available', async () => {
    await __testing.persistSnapshot({
      bundleId: 'bundle-before-login',
      severity: 'crash',
      errorCategory: 'CLIENT_CRASH',
      errorCode: 'PRE_LOGIN_CRASH',
      handledBy: 'next_start_recovery',
      clientInstallId: 'install-1',
    })

    expect(await getPendingDiagnosticBundles()).toEqual([])
    await bindPendingDiagnosticOrganization('org-after-login')

    const [entry] = await getPendingDiagnosticBundles()
    expect(entry).toMatchObject({
      bundle_id: 'bundle-before-login',
      organization_id: 'org-after-login',
      next_attempt_at: null,
    })
  })

  it('isolates corrupt queue metadata and continues serving valid entries', async () => {
    await __testing.persistSnapshot({
      bundleId: 'bundle-valid',
      severity: 'fatal',
      errorCategory: 'IPC_FATAL',
      errorCode: 'VALID_ENTRY',
      handledBy: 'test',
      organizationId: 'org-1',
      clientInstallId: 'install-1',
    })
    await fsp.writeFile(path.join(userDataDir, 'diagnostics-v1', 'pending', 'corrupt.json'), '{broken')

    const entries = await __testing.readPendingMetadata()
    expect(entries.map(entry => entry.bundle_id)).toEqual(['bundle-valid'])
  })

  it('keeps only the first and latest bundle during a crash loop', async () => {
    for (const bundleId of ['loop-1', 'loop-2', 'loop-3', 'loop-4']) {
      await __testing.persistSnapshot({
        bundleId,
        severity: 'crash',
        errorCategory: 'CLIENT_CRASH',
        errorCode: 'REPEATED_CRASH',
        handledBy: 'test',
        organizationId: 'org-1',
        clientInstallId: 'install-1',
      })
    }

    const entries = await __testing.readPendingMetadata()
    expect(entries.map(entry => entry.bundle_id).sort()).toEqual(['loop-1', 'loop-4'])
  })

  it('keeps the product flow alive when the diagnostic disk is full', async () => {
    const diskFull = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const persist = vi.fn().mockRejectedValue(diskFull)

    await expect(__testing.persistSnapshotFailOpen({
      bundleId: 'bundle-disk-full',
      severity: 'fatal',
      errorCategory: 'LOCAL_DATA_FATAL',
      errorCode: 'DIAGNOSTIC_DISK_FULL',
      handledBy: 'test',
      organizationId: 'org-1',
      clientInstallId: 'install-1',
    }, persist)).resolves.toBeUndefined()
    expect(persist).toHaveBeenCalledOnce()
    expect(await __testing.readPendingMetadata()).toEqual([])
  })
})
