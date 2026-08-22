import {
  PythonRuntimeError,
  type PythonRuntimeManifest,
  type PythonRuntimePlatformEntry,
} from './types.js'

/**
 * 期望的平台标识 `<platform>-<arch>`（如 darwin-arm64 / win32-x64）。
 * 用 node 的 process 值——属基础设施信息，非业务。
 */
export function expectedPlatform(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  return `${process.platform}-${arch}`
}

/** 归档内相对路径安全校验：禁止绝对路径、盘符、`..` 穿越。 */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  const normalized = value.replace(/\\/g, '/')
  return !normalized.split('/').includes('..')
}

function validateEntry(platform: string, entry: unknown, source: string): PythonRuntimePlatformEntry {
  const e = entry as Partial<PythonRuntimePlatformEntry>
  if (!e || typeof e.archiveName !== 'string' || !isSafeRelativePath(e.archiveName) || !e.sha256 || !e.entrypoint || !isSafeRelativePath(e.entrypoint)) {
    throw new PythonRuntimeError('MANIFEST_INVALID', `平台 ${platform} 的条目缺字段或非法: ${source}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(e.sha256)) {
    throw new PythonRuntimeError('MANIFEST_INVALID', `平台 ${platform} 的 sha256 非法: ${source}`)
  }
  if (e.size !== undefined && (!Number.isSafeInteger(e.size) || e.size <= 0)) {
    throw new PythonRuntimeError('MANIFEST_INVALID', `平台 ${platform} 的 size 非法: ${source}`)
  }
  return e as PythonRuntimePlatformEntry
}

export function parseManifest(raw: string, source: string): PythonRuntimeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PythonRuntimeError('MANIFEST_INVALID', `python runtime manifest 不是合法 JSON: ${source}`)
  }

  const m = parsed as Partial<PythonRuntimeManifest>
  if (m.schemaVersion !== 2 || m.runtimeKind !== 'python' || !m.version || !m.platforms || typeof m.platforms !== 'object') {
    throw new PythonRuntimeError('MANIFEST_INVALID', `python runtime manifest 缺少必填字段或 schema 不符(需 v2): ${source}`)
  }
  const entries = Object.entries(m.platforms as Record<string, unknown>)
  if (entries.length === 0) {
    throw new PythonRuntimeError('MANIFEST_INVALID', `python runtime manifest platforms 为空: ${source}`)
  }
  for (const [platform, entry] of entries) validateEntry(platform, entry, source)
  return m as PythonRuntimeManifest
}

/** 选出本机平台对应的条目；无则返回 null（此包不覆盖当前平台）。 */
export function selectPlatformEntry(manifest: PythonRuntimeManifest): PythonRuntimePlatformEntry | null {
  return manifest.platforms[expectedPlatform()] ?? null
}
