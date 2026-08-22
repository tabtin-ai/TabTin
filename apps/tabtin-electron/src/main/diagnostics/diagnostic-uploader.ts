import fsp from 'node:fs/promises'

import { API_BASE_URL } from '../config/api'
import { TokenManager } from '../auth'
import { getCLIOrganizationId } from '../cli/cli-context'
import {
  bindPendingDiagnosticOrganization,
  getPendingDiagnosticBundles,
  linkDiagnosticServerBundle,
  markDiagnosticUploadFailure,
  removeUploadedDiagnosticBundle,
  type PendingDiagnosticBundle,
} from './diagnostic-runtime'

async function uploadOne(entry: PendingDiagnosticBundle): Promise<void> {
  const token = await TokenManager.getAccessToken()
  if (!token) throw new Error('authentication unavailable')
  let serverBundleId = entry.server_bundle_id
  if (!serverBundleId) {
    const createResponse = await fetch(`${API_BASE_URL}/diagnostics/bundles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: entry.organization_id,
        client_install_id: entry.client_install_id,
        expected_size: entry.bytes,
        expected_sha256: entry.expected_sha256,
        content_type: 'application/zip',
        sentry_event_id: entry.sentry_event_id,
        source: entry.severity === 'manual' ? 'support_upload' : 'incident',
      }),
    })
    if (!createResponse.ok) throw new Error(`create bundle failed: ${createResponse.status}`)
    const session = await createResponse.json() as {
      bundle_id: string
      upload_url: string
      upload_method?: 'PUT' | 'POST'
      upload_fields?: Record<string, string>
    }
    const content = await fsp.readFile(entry.bundle_path)
    let uploadResponse: Response
    if (session.upload_method === 'POST') {
      const form = new FormData()
      for (const [key, value] of Object.entries(session.upload_fields ?? {})) form.append(key, value)
      form.append('file', new Blob([new Uint8Array(content)], { type: 'application/zip' }), `${entry.bundle_id}.zip`)
      uploadResponse = await fetch(session.upload_url, { method: 'POST', body: form })
    } else {
      uploadResponse = await fetch(session.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        body: content,
      })
    }
    if (!uploadResponse.ok) throw new Error(`object upload failed: ${uploadResponse.status}`)
    serverBundleId = session.bundle_id
    await linkDiagnosticServerBundle(entry.bundle_id, serverBundleId)
  }
  const completeResponse = await fetch(
    `${API_BASE_URL}/diagnostics/bundles/${serverBundleId}/complete`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256: entry.expected_sha256, size: entry.bytes }),
    },
  )
  if (!completeResponse.ok) throw new Error(`complete bundle failed: ${completeResponse.status}`)
  await removeUploadedDiagnosticBundle(entry.bundle_id)
}

async function runPendingDiagnosticFlush(): Promise<void> {
  const organizationId = getCLIOrganizationId()
  if (organizationId) await bindPendingDiagnosticOrganization(organizationId)
  for (const entry of await getPendingDiagnosticBundles()) {
    try {
      await uploadOne(entry)
    } catch {
      await markDiagnosticUploadFailure(entry.bundle_id)
    }
  }
}

let activeFlush: Promise<void> | null = null

export function flushPendingDiagnosticBundles(): Promise<void> {
  if (activeFlush) return activeFlush
  activeFlush = runPendingDiagnosticFlush().finally(() => {
    activeFlush = null
  })
  return activeFlush
}

let retryTimer: ReturnType<typeof setInterval> | null = null

export function startDiagnosticUploader(): void {
  if (retryTimer) return
  void flushPendingDiagnosticBundles()
  retryTimer = setInterval(() => void flushPendingDiagnosticBundles(), 60_000)
  retryTimer.unref?.()
}
