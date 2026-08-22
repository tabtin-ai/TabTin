import type { GitCommitListItem, GitCommitRef, GitLogOptions } from './git-types'

export const GIT_LOG_LINE_FORMAT = '%H%x1f%h%x1f%s%x1f%an%x1f%aI'
export const GIT_LOG_GRAPH_FORMAT = '%H%x1f%h%x1f%P%x1f%d%x1f%s%x1f%an%x1f%aI'

const MAX_LOG_LIMIT = 200
const DEFAULT_LINE_LIMIT = 50
const DEFAULT_GRAPH_LIMIT = 200

export function resolveGitLogLimit(options?: GitLogOptions): number {
  const fallback = options?.graph ? DEFAULT_GRAPH_LIMIT : DEFAULT_LINE_LIMIT
  return Math.min(Math.max(Number(options?.limit) || fallback, 1), MAX_LOG_LIMIT)
}

/** 默认路径必须与现网 Changes 提交历史一致，多一个参数都会改变行为。 */
export function buildGitLogArgs(options?: GitLogOptions): string[] {
  const limit = resolveGitLogLimit(options)
  if (options?.graph) {
    return [
      'log',
      '--all',
      '--topo-order',
      '--decorate=full',
      `-n${limit}`,
      `--format=${GIT_LOG_GRAPH_FORMAT}`,
    ]
  }
  return ['log', `-n${limit}`, `--format=${GIT_LOG_LINE_FORMAT}`]
}

export function parseGitDecorate(raw: string): GitCommitRef[] {
  const inner = raw.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  if (!inner) return []

  const refs: GitCommitRef[] = []
  for (const part of inner.split(',').map((item) => item.trim()).filter(Boolean)) {
    if (part.startsWith('HEAD -> ')) {
      refs.push({ kind: 'head', name: 'HEAD' })
      refs.push(parseDecorateName(part.slice('HEAD -> '.length)))
      continue
    }
    if (part === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' })
      continue
    }
    refs.push(parseDecorateName(part))
  }
  return refs
}

function parseDecorateName(name: string): GitCommitRef {
  if (name.startsWith('tag: ')) {
    return { kind: 'tag', name: stripRefPrefix(name.slice(5), 'refs/tags/') }
  }
  if (name.startsWith('refs/tags/')) {
    return { kind: 'tag', name: name.slice('refs/tags/'.length) }
  }
  if (name.startsWith('refs/remotes/')) {
    return { kind: 'remote', name: name.slice('refs/remotes/'.length) }
  }
  if (name.startsWith('refs/heads/')) {
    return { kind: 'branch', name: name.slice('refs/heads/'.length) }
  }
  return { kind: 'branch', name }
}

function stripRefPrefix(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

export function parseGitLogLine(line: string, graph: boolean): GitCommitListItem | null {
  const parts = line.split('\x1f')
  if (graph) {
    const [
      hash = '',
      shortHash = '',
      parentsRaw = '',
      decorate = '',
      subject = '',
      authorName = '',
      authoredAt = '',
    ] = parts
    const trimmedHash = hash.trim()
    if (!trimmedHash) return null
    return {
      hash: trimmedHash,
      shortHash: shortHash.trim(),
      subject: subject.trim(),
      authorName: authorName.trim(),
      authoredAt: authoredAt.trim(),
      parents: parentsRaw.trim().split(/\s+/).filter(Boolean),
      refs: parseGitDecorate(decorate),
    }
  }

  const [hash = '', shortHash = '', subject = '', authorName = '', authoredAt = ''] = parts
  const trimmedHash = hash.trim()
  if (!trimmedHash) return null
  return {
    hash: trimmedHash,
    shortHash: shortHash.trim(),
    subject: subject.trim(),
    authorName: authorName.trim(),
    authoredAt: authoredAt.trim(),
  }
}
