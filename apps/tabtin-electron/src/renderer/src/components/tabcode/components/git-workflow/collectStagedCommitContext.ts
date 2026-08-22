/**
 * 组装可发送给 AI 的 commit 上下文：按策略选源 + 限长 + 敏感检查。
 */

export const MAX_STAGED_DIFF_CHARS = 24 * 1024

/** 未跟踪文件单文件预览上限（最终仍受全局 24KB 截断） */
const MAX_UNTRACKED_PREVIEW_BYTES = 24 * 1024

const SENSITIVE_PATH_RE =
  /(?:^|\/)(?:\.env(?:\..+)?|.*\.(?:pem|p12|pfx|key)|id_rsa|id_ed25519|credentials\.json|secrets?(?:\.[^/]+)?)$/i

const SENSITIVE_CONTENT_RE =
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/i

export type CommitDiffScope = 'staged' | 'workspace'

export type CommitMessageContextResult =
  | {
      ok: true
      files: string[]
      diffExcerpt: string
      truncated: boolean
      scope: CommitDiffScope
    }
  | {
      ok: false
      reason: 'empty' | 'sensitive' | 'diff_failed'
      error?: string
      scope: CommitDiffScope
    }

/** @deprecated 使用 CommitMessageContextResult */
export type StagedCommitContextResult = CommitMessageContextResult

function extractFilesFromNameOnly(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function joinRootPath(rootPath: string, filePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${filePath.replace(/^[\\/]+/, '')}`
}

function formatUntrackedDiff(filePath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0
    ? []
    : (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
  const hunkLineCount = lines.length
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${hunkLineCount} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n')
}

export function hasSensitiveCommitContent(files: string[], diff: string): boolean {
  if (files.some((path) => SENSITIVE_PATH_RE.test(path))) {
    return true
  }
  return SENSITIVE_CONTENT_RE.test(diff)
}

/** @deprecated 使用 hasSensitiveCommitContent */
export const hasSensitiveStagedContent = hasSensitiveCommitContent

export function truncateDiff(diff: string, maxChars = MAX_STAGED_DIFF_CHARS): {
  diffExcerpt: string
  truncated: boolean
} {
  if (diff.length <= maxChars) {
    return { diffExcerpt: diff, truncated: false }
  }
  return { diffExcerpt: diff.slice(0, maxChars), truncated: true }
}

function finalizeContext(
  scope: CommitDiffScope,
  files: string[],
  rawDiff: string,
): CommitMessageContextResult {
  if (files.length === 0 && !rawDiff.trim()) {
    return { ok: false, reason: 'empty', scope }
  }

  if (hasSensitiveCommitContent(files, rawDiff)) {
    return { ok: false, reason: 'sensitive', scope }
  }

  const { diffExcerpt, truncated } = truncateDiff(rawDiff)
  if (!diffExcerpt.trim() && files.length === 0) {
    return { ok: false, reason: 'empty', scope }
  }

  return {
    ok: true,
    files,
    diffExcerpt: diffExcerpt || files.map((path) => `M\t${path}`).join('\n'),
    truncated,
    scope,
  }
}

async function collectStagedScope(rootPath: string): Promise<CommitMessageContextResult> {
  const scope: CommitDiffScope = 'staged'
  const [namesResult, diffResult] = await Promise.all([
    window.tabtin.git.rawDiff(rootPath, ['--cached', '--name-only']),
    window.tabtin.git.rawDiff(rootPath, ['--cached']),
  ])

  if (!namesResult?.success && !diffResult?.success) {
    return {
      ok: false,
      reason: 'diff_failed',
      error: namesResult?.error || diffResult?.error || 'rawDiff failed',
      scope,
    }
  }

  const files = extractFilesFromNameOnly(namesResult?.diff || '')
  const rawDiff = diffResult?.success ? (diffResult.diff || '') : ''
  return finalizeContext(scope, files, rawDiff)
}

async function collectUntrackedDiffs(
  rootPath: string,
  untrackedPaths: string[],
): Promise<{
  files: string[]
  diffs: string[]
  previewTruncated: boolean
  sensitiveContent: boolean
}> {
  const files: string[] = []
  const diffs: string[] = []
  let previewTruncated = false
  let sensitiveContent = false
  let remaining = MAX_STAGED_DIFF_CHARS

  for (const filePath of untrackedPaths) {
    if (remaining <= 0) {
      previewTruncated = true
      // 预算耗尽后仍登记剩余路径，便于敏感路径拦截与「有变更」语义
      files.push(filePath)
      continue
    }

    // 敏感路径先入 files，由 finalize 统一拦截，避免继续读内容
    if (SENSITIVE_PATH_RE.test(filePath)) {
      files.push(filePath)
      continue
    }

    try {
      // 预览按全局预算读取；内容先做敏感扫描再拼进 payload
      const result = await window.tabtin.fileSystem.readFilePreview(
        joinRootPath(rootPath, filePath),
        { maxBytes: MAX_UNTRACKED_PREVIEW_BYTES },
      )
      if (!result?.success) {
        files.push(filePath)
        continue
      }
      if (result.data?.kind !== 'text') {
        // 二进制等非文本：只保留路径名，不附内容
        files.push(filePath)
        continue
      }
      const content = result.data.content || ''
      if (SENSITIVE_CONTENT_RE.test(content)) {
        sensitiveContent = true
        files.push(filePath)
        continue
      }
      if (result.data.truncated) previewTruncated = true
      const formatted = formatUntrackedDiff(filePath, content)
      const clipped = formatted.length > remaining
        ? formatted.slice(0, remaining)
        : formatted
      if (clipped.trim()) {
        diffs.push(clipped)
        remaining -= clipped.length
      }
      files.push(filePath)
      if (clipped.length < formatted.length || remaining <= 0) previewTruncated = true
    } catch {
      // 单文件预览失败不阻断整体收集；至少保留路径
      files.push(filePath)
    }
  }

  return { files, diffs, previewTruncated, sensitiveContent }
}

async function collectWorkspaceScope(rootPath: string): Promise<CommitMessageContextResult> {
  const scope: CommitDiffScope = 'workspace'
  const [namesResult, diffResult, statusResult] = await Promise.all([
    window.tabtin.git.rawDiff(rootPath, ['--name-only']),
    window.tabtin.git.rawDiff(rootPath, []),
    window.tabtin.git.getStatus(rootPath),
  ])

  if (!namesResult?.success && !diffResult?.success && !statusResult?.success) {
    return {
      ok: false,
      reason: 'diff_failed',
      error: namesResult?.error || diffResult?.error || 'workspace collect failed',
      scope,
    }
  }

  const trackedFiles = extractFilesFromNameOnly(namesResult?.diff || '')
  const trackedDiff = diffResult?.success ? (diffResult.diff || '') : ''

  const entries = statusResult?.success
    ? (statusResult.entries ?? {})
    : {}
  const untrackedPaths = Object.entries(entries)
    .filter(([, entry]) => entry.x === '?' && entry.y === '?')
    .map(([path]) => path)
    .sort((a, b) => a.localeCompare(b))

  const untracked = await collectUntrackedDiffs(rootPath, untrackedPaths)
  if (untracked.sensitiveContent) {
    return { ok: false, reason: 'sensitive', scope }
  }

  const files = Array.from(new Set([...trackedFiles, ...untracked.files])).sort((a, b) =>
    a.localeCompare(b),
  )
  const parts = [trackedDiff, ...untracked.diffs].filter((part) => part.trim())
  const rawDiff = parts.join(parts.length > 1 ? '\n' : '')
  const result = finalizeContext(scope, files, rawDiff)
  if (result.ok && untracked.previewTruncated) {
    return { ...result, truncated: true }
  }
  return result
}

export async function collectCommitMessageContext(
  rootPath: string,
  scope: CommitDiffScope,
): Promise<CommitMessageContextResult> {
  if (scope === 'staged') {
    return collectStagedScope(rootPath)
  }
  return collectWorkspaceScope(rootPath)
}

/** @deprecated 使用 collectCommitMessageContext(rootPath, 'staged') */
export async function collectStagedCommitContext(
  rootPath: string,
): Promise<CommitMessageContextResult> {
  return collectCommitMessageContext(rootPath, 'staged')
}
