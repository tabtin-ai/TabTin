/**
 * 本机编辑工具补丁账本。
 *
 * 落点：`~/.tabtin/file-edit-patches/<sha256(threadId)>.jsonl`
 * 每行一条成功的 edit/write/delete 冻结补丁，按 toolUseId 寻址。
 * 不上传、不进 Django；重启后同机可读。
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import type { FileEditPatch } from '@tabtin/agent-host/tools'
import { readFileEditPatch } from '@tabtin/agent-host/tools'
import { createLogger } from '../logger'

const log = createLogger('FileEditPatchStore')

export interface FileEditPatchRecord {
  toolUseId: string
  recordedAt: string
  /** 写盘时 Agent 实际执行的代码根；旧记录缺失时不归属到任一 worktree。 */
  codeRootPath?: string
  patch: FileEditPatch
}

export function fileEditPatchJournalPath(threadId: string, rootDir?: string): string {
  const root = rootDir ?? getHomeTabtinPath('file-edit-patches')
  const hash = createHash('sha256').update(threadId).digest('hex')
  return path.join(root, `${hash}.jsonl`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseFileEditPatchRecord(line: string): FileEditPatchRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) return null
    if (typeof parsed.toolUseId !== 'string' || !parsed.toolUseId.trim()) return null
    if (typeof parsed.recordedAt !== 'string' || !parsed.recordedAt.trim()) return null
    const patch = readFileEditPatch({ fileEditPatch: parsed.patch })
    if (!patch) return null
    const codeRootPath = typeof parsed.codeRootPath === 'string' && parsed.codeRootPath.trim()
      ? parsed.codeRootPath.trim()
      : undefined
    return {
      toolUseId: parsed.toolUseId,
      recordedAt: parsed.recordedAt,
      ...(codeRootPath ? { codeRootPath } : {}),
      patch,
    }
  } catch {
    return null
  }
}

export async function listFileEditPatchRecords(
  threadId: string,
  rootDir?: string,
): Promise<FileEditPatchRecord[]> {
  const id = threadId.trim()
  if (!id) return []
  const filePath = fileEditPatchJournalPath(id, rootDir)
  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      log.debug('journal missing', { threadId, filePath })
      return []
    }
    throw error
  }
  const records: FileEditPatchRecord[] = []
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    const record = parseFileEditPatchRecord(line)
    if (!record || seen.has(record.toolUseId)) continue
    seen.add(record.toolUseId)
    records.push(record)
  }
  return records
}

export async function recordFileEditPatch(
  input: {
    threadId: string
    toolUseId: string
    codeRootPath?: string
    patch: FileEditPatch
  },
  rootDir?: string,
): Promise<void> {
  const threadId = input.threadId.trim()
  const toolUseId = input.toolUseId.trim()
  if (!threadId || !toolUseId) return
  const existing = await listFileEditPatchRecords(threadId, rootDir)
  if (existing.some((item) => item.toolUseId === toolUseId)) return

  const filePath = fileEditPatchJournalPath(threadId, rootDir)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const codeRootPath = input.codeRootPath?.trim() || undefined
  const record: FileEditPatchRecord = {
    toolUseId,
    recordedAt: new Date().toISOString(),
    ...(codeRootPath ? { codeRootPath } : {}),
    patch: normalizePatchPath(input.patch, codeRootPath),
  }
  await fsp.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  log.debug('[DEBUG-code-diff-review] journal append complete', {
    threadId,
    toolUseId,
    filePath,
    recordCount: existing.length + 1,
  })
  log.info('recorded editor patch', {
    threadId,
    toolUseId,
    codeRootPath,
    toolName: input.patch.toolName,
    relativePath: record.patch.relativePath,
    status: input.patch.status,
  })
}

function normalizePatchPath(patch: FileEditPatch, codeRootPath: string | undefined): FileEditPatch {
  if (!codeRootPath || !path.isAbsolute(patch.relativePath)) return patch
  const relativePath = path.relative(codeRootPath, patch.relativePath)
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return patch
  }
  return {
    ...patch,
    relativePath: relativePath.split(path.sep).join('/'),
  }
}
