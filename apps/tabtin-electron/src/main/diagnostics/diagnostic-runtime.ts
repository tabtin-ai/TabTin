import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'

import { app } from 'electron'
import JSZip from 'jszip'

const MAX_BUNDLES = 5
const MAX_TOTAL_BYTES = 150 * 1024 * 1024
const MAX_BREADCRUMBS = 200
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const

export interface DiagnosticBreadcrumb {
  timestamp: string
  category: string
  code: string
  outcome?: string
  duration_bucket?: string
}

export interface PendingDiagnosticBundle {
  bundle_id: string
  created_at: string
  severity: 'fatal' | 'crash' | 'manual'
  error_category: string
  error_code: string
  release: string
  organization_id: string
  client_install_id: string
  sentry_event_id: string
  server_bundle_id?: string
  status: 'pending' | 'failed'
  attempt_count: number
  next_attempt_at: string | null
  bundle_path: string
  bytes: number
  expected_sha256: string
}

const breadcrumbs: DiagnosticBreadcrumb[] = []

function runtimeDir(): string {
  return path.join(app.getPath('userData'), 'diagnostics-v1')
}

function pendingDir(): string {
  return path.join(runtimeDir(), 'pending')
}

function markerPath(): string {
  return path.join(runtimeDir(), 'session.json')
}

export function recordDiagnosticBreadcrumb(input: Omit<DiagnosticBreadcrumb, 'timestamp'>): void {
  breadcrumbs.push({ timestamp: new Date().toISOString(), ...input })
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift()
}

async function readPendingMetadata(): Promise<PendingDiagnosticBundle[]> {
  try {
    const names = await fsp.readdir(pendingDir())
    const entries = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try {
        return JSON.parse(await fsp.readFile(path.join(pendingDir(), name), 'utf8')) as PendingDiagnosticBundle
      } catch {
        return null
      }
    }))
    return entries.filter((entry): entry is PendingDiagnosticBundle => entry !== null)
  } catch {
    return []
  }
}

export async function getPendingDiagnosticBundles(): Promise<PendingDiagnosticBundle[]> {
  const now = Date.now()
  return (await readPendingMetadata()).filter(entry =>
    entry.status === 'pending'
    && entry.organization_id.length > 0
    && (entry.next_attempt_at === null || Date.parse(entry.next_attempt_at) <= now))
}

export async function bindPendingDiagnosticOrganization(organizationId: string): Promise<void> {
  const normalizedOrganizationId = organizationId.trim()
  if (!normalizedOrganizationId) return
  for (const entry of await readPendingMetadata()) {
    if (entry.organization_id || entry.status !== 'pending') continue
    entry.organization_id = normalizedOrganizationId
    entry.next_attempt_at = null
    await fsp.writeFile(
      path.join(pendingDir(), `${entry.bundle_id}.json`),
      JSON.stringify(entry, null, 2),
    )
  }
}

export async function removeUploadedDiagnosticBundle(bundleId: string): Promise<void> {
  const metadataPath = path.join(pendingDir(), `${bundleId}.json`)
  try {
    const entry = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as PendingDiagnosticBundle
    await Promise.allSettled([fsp.unlink(entry.bundle_path), fsp.unlink(metadataPath)])
  } catch {
    // A later capacity pass can clean up a corrupt orphan.
  }
}

async function prunePendingBundles(): Promise<void> {
  let entries = (await readPendingMetadata()).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const deleteEntry = async (entry: PendingDiagnosticBundle): Promise<void> => {
    await Promise.allSettled([
      fsp.unlink(entry.bundle_path),
      fsp.unlink(path.join(pendingDir(), `${entry.bundle_id}.json`)),
    ])
  }
  const crashLoopGroups = new Map<string, PendingDiagnosticBundle[]>()
  for (const entry of entries) {
    const key = `${entry.release}:${entry.error_category}:${entry.error_code}`
    const group = crashLoopGroups.get(key) ?? []
    group.push(entry)
    crashLoopGroups.set(key, group)
  }
  for (const group of crashLoopGroups.values()) {
    if (group.length <= 3) continue
    const firstAt = Date.parse(group[0]!.created_at)
    const latestAt = Date.parse(group[group.length - 1]!.created_at)
    if (latestAt - firstAt > 10 * 60_000) continue
    for (const redundant of group.slice(1, -1)) await deleteEntry(redundant)
  }
  entries = await readPendingMetadata()
  entries.sort((a, b) => a.created_at.localeCompare(b.created_at))
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  while (entries.length > MAX_BUNDLES || total > MAX_TOTAL_BYTES) {
    const oldest = entries.shift()
    if (!oldest) break
    total -= oldest.bytes
    await deleteEntry(oldest)
  }
}

async function persistSnapshot(input: {
  bundleId: string
  severity: 'fatal' | 'crash'
  errorCategory: string
  errorCode: string
  handledBy: string
  organizationId?: string
  clientInstallId: string
}): Promise<void> {
  await fsp.mkdir(pendingDir(), { recursive: true })
  const createdAt = new Date().toISOString()
  const bundlePath = path.join(pendingDir(), `${input.bundleId}.zip`)
  const zip = new JSZip()
  zip.file('meta.json', JSON.stringify({
    schema_version: 1,
    diagnostic_bundle_id: input.bundleId,
    created_at: createdAt,
    severity: input.severity,
    error_category: input.errorCategory,
    error_code: input.errorCode,
    release: app.getVersion(),
    handled_by: input.handledBy,
    organization_id: input.organizationId,
    client_install_id: input.clientInstallId,
    app_version: app.getVersion(),
    platform: process.platform,
    runtime: 'electron-main',
  }, null, 2))
  zip.file('breadcrumbs.json', JSON.stringify(breadcrumbs, null, 2))
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await fsp.writeFile(bundlePath, buffer, { flag: 'wx' })
  const metadata: PendingDiagnosticBundle = {
    bundle_id: input.bundleId,
    created_at: createdAt,
    severity: input.severity,
    error_category: input.errorCategory,
    error_code: input.errorCode,
    release: app.getVersion(),
    organization_id: input.organizationId ?? '',
    client_install_id: input.clientInstallId,
    sentry_event_id: '',
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: new Date(Date.now() + RETRY_DELAYS_MS[0]).toISOString(),
    bundle_path: bundlePath,
    bytes: buffer.length,
    expected_sha256: createHash('sha256').update(buffer).digest('hex'),
  }
  await fsp.writeFile(
    path.join(pendingDir(), `${input.bundleId}.json`),
    JSON.stringify(metadata, null, 2),
    { flag: 'wx' },
  )
  await prunePendingBundles()
}

async function persistSnapshotFailOpen(
  input: Parameters<typeof persistSnapshot>[0],
  persist: typeof persistSnapshot = persistSnapshot,
): Promise<void> {
  try {
    await persist(input)
  } catch {
    // Diagnostics must never turn an application failure into a second crash.
  }
}

export function scheduleFatalDiagnostic(input: {
  severity: 'fatal' | 'crash'
  errorCategory: string
  errorCode: string
  handledBy: string
  organizationId?: string
  clientInstallId: string
}): string {
  const bundleId = randomUUID()
  void persistSnapshotFailOpen({ bundleId, ...input })
  return bundleId
}

/**
 * 用户明确选择「上传给技术支持」时，把已脱敏且注入 main.log 的完整 zip 纳入同一
 * 可靠上传队列。它不会自动采集，也不会改变 fatal/crash 的轻量诊断包策略。
 */
export async function queueSupportDiagnosticBundle(input: {
  buffer: Buffer
  organizationId: string
  clientInstallId: string
}): Promise<string> {
  if (!input.organizationId.trim()) throw new Error('当前未选择组织，无法上传诊断包')
  await fsp.mkdir(pendingDir(), { recursive: true })
  const bundleId = randomUUID()
  const createdAt = new Date().toISOString()
  const bundlePath = path.join(pendingDir(), `${bundleId}.zip`)
  await fsp.writeFile(bundlePath, input.buffer, { flag: 'wx' })
  const metadata: PendingDiagnosticBundle = {
    bundle_id: bundleId,
    created_at: createdAt,
    severity: 'manual',
    error_category: 'USER_REQUESTED_SUPPORT_UPLOAD',
    error_code: 'FULL_DIAGNOSTICS',
    release: app.getVersion(),
    organization_id: input.organizationId.trim(),
    client_install_id: input.clientInstallId,
    sentry_event_id: '',
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    bundle_path: bundlePath,
    bytes: input.buffer.length,
    expected_sha256: createHash('sha256').update(input.buffer).digest('hex'),
  }
  await fsp.writeFile(path.join(pendingDir(), `${bundleId}.json`), JSON.stringify(metadata, null, 2), { flag: 'wx' })
  await prunePendingBundles()
  return bundleId
}

export async function markDiagnosticUploadFailure(bundleId: string): Promise<void> {
  const metadataPath = path.join(pendingDir(), `${bundleId}.json`)
  try {
    const entry = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as PendingDiagnosticBundle
    entry.attempt_count += 1
    const delay = RETRY_DELAYS_MS[entry.attempt_count]
    entry.status = delay === undefined ? 'failed' : 'pending'
    entry.next_attempt_at = delay === undefined ? null : new Date(Date.now() + delay).toISOString()
    await fsp.writeFile(metadataPath, JSON.stringify(entry, null, 2))
  } catch {
    // Corrupt or missing queue entries are isolated from the product flow.
  }
}

export async function linkDiagnosticSentryEvent(bundleId: string, sentryEventId: string | undefined): Promise<void> {
  if (!sentryEventId) return
  const metadataPath = path.join(pendingDir(), `${bundleId}.json`)
  try {
    const entry = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as PendingDiagnosticBundle
    entry.sentry_event_id = sentryEventId
    await fsp.writeFile(metadataPath, JSON.stringify(entry, null, 2))
  } catch {
    // The Sentry event remains valid even if the optional local association fails.
  }
}

export async function linkDiagnosticServerBundle(bundleId: string, serverBundleId: string): Promise<void> {
  const metadataPath = path.join(pendingDir(), `${bundleId}.json`)
  const entry = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as PendingDiagnosticBundle
  entry.server_bundle_id = serverBundleId
  await fsp.writeFile(metadataPath, JSON.stringify(entry, null, 2))
}

export async function startDiagnosticSession(): Promise<void> {
  await fsp.mkdir(runtimeDir(), { recursive: true })
  try {
    const previous = JSON.parse(await fsp.readFile(markerPath(), 'utf8')) as { status?: string; session_id?: string }
    if (previous.status === 'running') {
      scheduleFatalDiagnostic({
        severity: 'crash',
        errorCategory: 'ABNORMAL_TERMINATION',
        errorCode: 'PREVIOUS_SESSION_UNCLEAN_EXIT',
        handledBy: 'next_start_recovery',
        clientInstallId: 'unknown',
      })
    }
  } catch {
    // First start or corrupt marker: start a fresh session.
  }
  await fsp.writeFile(markerPath(), JSON.stringify({
    session_id: randomUUID(),
    started_at: new Date().toISOString(),
    status: 'running',
  }))
}

export async function markDiagnosticSessionClean(): Promise<void> {
  try {
    await fsp.writeFile(markerPath(), JSON.stringify({
      ended_at: new Date().toISOString(),
      status: 'clean',
    }))
  } catch {
    // Shutdown must continue even when the marker cannot be written.
  }
}

export const diagnosticRuntimeLimits = {
  maxBundles: MAX_BUNDLES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  retryDelaysMs: RETRY_DELAYS_MS,
}

export const __testing = {
  persistSnapshot,
  persistSnapshotFailOpen,
  readPendingMetadata,
  prunePendingBundles,
}
