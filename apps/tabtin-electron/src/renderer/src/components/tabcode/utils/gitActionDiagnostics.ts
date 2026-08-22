import { basename } from './path'

function diagnosticHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function basenameForDiagnostic(value: string): string {
  return basename(value.replace(/\\/g, '/'))
}

function redactKnownPath(text: string, knownPath: string, replacement: string): string {
  if (!knownPath) return text
  const normalized = knownPath.replace(/\\/g, '/')
  return text
    .split(knownPath).join(replacement)
    .split(normalized).join(replacement)
}

function redactDiagnosticError(text: string, rootPath: string, paths: string[]): string {
  let redacted = redactKnownPath(text, rootPath, '<git-root>')
  for (const relPath of paths) {
    const separator = rootPath.includes('\\') ? '\\' : '/'
    const absolutePath = `${rootPath.replace(/[\\/]+$/, '')}${separator}${relPath.replace(/^[\\/]+/, '')}`
    redacted = redactKnownPath(redacted, absolutePath, `<git-path:${diagnosticHash(relPath)}>`)
  }
  redacted = redacted.replace(/\/Users\/[^/\s'"]+/g, '/Users/<user>')
  redacted = redacted.replace(/[A-Za-z]:[\\/][^\s'"]+/g, '<abs-path>')
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…` : redacted
}

function readDiagnosticError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>
    return [record.code, record.detail, record.error, record.message]
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('\n')
  }
  return ''
}

export function logGitActionFailure(action: string, rootPath: string, paths: string[], error: unknown): void {
  const errorText = readDiagnosticError(error)
  console.warn('[TabCode:GitAction] failed', {
    action,
    rootBase: basenameForDiagnostic(rootPath),
    rootHash: diagnosticHash(rootPath),
    pathCount: paths.length,
    pathSamples: paths.slice(0, 5).map((path) => ({
      name: basenameForDiagnostic(path),
      pathHash: diagnosticHash(path),
      depth: path.replace(/\\/g, '/').split('/').filter(Boolean).length,
    })),
    error: redactDiagnosticError(errorText, rootPath, paths),
  })
}
