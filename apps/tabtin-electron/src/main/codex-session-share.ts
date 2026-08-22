import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { shell } from 'electron'
import JSZip from 'jszip'
import {
  NodeImportIO,
  assertImportSourcePath,
  getAdapter,
} from '@tabtin/agent-import'
import type { ImportScanResult, ImportSessionRef } from '@tabtin/cli-server-core'
import { resolveImportAttachmentDir } from './agent-import/runner'
import { indexScanSessions } from './agent-import/resolve-session-refs'

export const CODEX_SESSION_SHARE_MAX_BYTES = 50 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface CodexSessionShareHeader {
  sessionId: string
  timestamp: string
  cwd: string
}

export interface CodexSessionShareFile {
  sessionId: string
  title: string
  fileName: string
  size: number
  buffer: ArrayBuffer
}

export interface CodexLocalProject {
  id: string
  name: string
  path: string
}

interface CodexGlobalProject {
  id: string
  name: string
  rootPaths: string[]
  createdAt: number
}

function safeFileStem(value: string): string {
  const stem = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return stem || 'Codex session'
}

async function scanCodexSessions(): Promise<ImportScanResult> {
  const io = new NodeImportIO(resolveImportAttachmentDir())
  const result = await getAdapter('codex').scan(io, { includeArchived: true })
  return result as unknown as ImportScanResult
}

async function requireAuthoritativeSession(sessionId: string): Promise<ImportSessionRef> {
  if (!UUID_RE.test(sessionId)) throw new Error('Codex session ID 无效')
  const scanned = await scanCodexSessions()
  const session = indexScanSessions('codex', scanned).get(sessionId)
  if (!session) throw new Error('找不到该 Codex session')
  assertImportSourcePath(
    new NodeImportIO(resolveImportAttachmentDir()),
    'codex',
    session.sourcePath,
  )
  return session
}

export function parseCodexSessionShareHeader(firstLine: string): CodexSessionShareHeader {
  let record: unknown
  try {
    record = JSON.parse(firstLine)
  } catch {
    throw new Error('不是有效的 Codex session JSONL')
  }
  const item = record as { type?: unknown; payload?: Record<string, unknown> }
  const payload = item?.payload
  const sessionId = typeof payload?.id === 'string'
    ? payload.id
    : typeof payload?.session_id === 'string'
      ? payload.session_id
      : ''
  const timestamp = typeof payload?.timestamp === 'string' ? payload.timestamp : ''
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
  if (item?.type !== 'session_meta' || !UUID_RE.test(sessionId)) {
    throw new Error('文件缺少有效的 Codex session_meta')
  }
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('Codex session 时间戳无效')
  }
  return { sessionId, timestamp, cwd }
}

export function rewriteCodexSessionCwd(data: Buffer, cwd: string): Buffer {
  const firstLineEnd = data.indexOf(0x0a)
  const firstLine = data.subarray(0, firstLineEnd >= 0 ? firstLineEnd : data.length).toString('utf8')
  parseCodexSessionShareHeader(firstLine)
  const record = JSON.parse(firstLine) as { payload: Record<string, unknown> }
  record.payload.cwd = cwd
  const rewritten = Buffer.from(JSON.stringify(record), 'utf8')
  return firstLineEnd >= 0
    ? Buffer.concat([rewritten, Buffer.from('\n'), data.subarray(firstLineEnd + 1)])
    : rewritten
}

export function nextImportedSessionTitle(baseTitle: string, existingTitles: Iterable<string>): string {
  const base = baseTitle.trim() || 'Imported Codex session'
  const occupied = new Set(existingTitles)
  if (!occupied.has(base)) return base
  let suffix = 2
  while (occupied.has(`${base} (${suffix})`)) suffix += 1
  return `${base} (${suffix})`
}

export function resolveCodexSessionShareTitle(
  indexedTitle: string,
  appServerName: string | null | undefined,
  sessionId: string,
): string {
  return appServerName?.trim() || indexedTitle.trim() || sessionId
}

export function resolveCodexProjectSelection(
  value: string,
  projects: CodexLocalProject[],
): string {
  const input = value.trim()
  if (path.isAbsolute(input)) return input
  const matches = projects.filter((project) => project.name.localeCompare(input, undefined, {
    sensitivity: 'accent',
  }) === 0)
  if (matches.length === 1) return matches[0].path
  throw new Error(matches.length > 1
    ? '存在同名 Codex Project，请从列表中选择具体目录'
    : '找不到该 Codex Project，请从列表中选择')
}

export function createCodexSessionRefreshFrame(sessionId: string): Buffer {
  const payload = Buffer.from(JSON.stringify({
    type: 'broadcast',
    method: 'thread-unarchived',
    sourceClientId: 'tabtin-session-import',
    version: 1,
    params: { hostId: 'local', conversationId: sessionId },
  }), 'utf8')
  const frame = Buffer.allocUnsafe(4 + payload.byteLength)
  frame.writeUInt32LE(payload.byteLength, 0)
  payload.copy(frame, 4)
  return frame
}

async function refreshRunningCodexSession(sessionId: string): Promise<boolean> {
  const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\codex-ipc'
    : process.platform === 'darwin'
      ? path.join(homedir(), '.codex', 'ipc', 'ipc.sock')
      : null
  if (!endpoint) return false
  return new Promise((resolve) => {
    const socket = connect(endpoint)
    const finish = (refreshed: boolean) => {
      socket.destroy()
      resolve(refreshed)
    }
    socket.setTimeout(2_000, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      socket.end(createCodexSessionRefreshFrame(sessionId), () => resolve(true))
    })
  })
}

async function resolveCodexExecutable(): Promise<string> {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        '/Applications/Codex.app/Contents/Resources/codex',
        path.join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
        path.join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
      ]
    : []
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next installed Desktop location.
    }
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex'
}

type CodexAppServerRequest = <T>(method: string, params: Record<string, unknown>) => Promise<T>

async function withCodexAppServer<T>(
  operation: (request: CodexAppServerRequest) => Promise<T>,
): Promise<T> {
  const executable = await resolveCodexExecutable()
  const child = spawn(executable, ['app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let nextRequestId = 1
    const pending = new Map<number, {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }>()
    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const finish = (error?: Error, result?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(result as T)
    }
    const request: CodexAppServerRequest = <R>(method: string, params: Record<string, unknown>) => {
      const id = nextRequestId++
      return new Promise<R>((requestResolve, requestReject) => {
        pending.set(id, {
          resolve: (value) => requestResolve(value as R),
          reject: requestReject,
        })
        send({ id, method, params })
      })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (line) {
          try {
            const message = JSON.parse(line) as {
              id?: number
              result?: unknown
              error?: { message?: unknown }
            }
            if (typeof message.id === 'number') {
              const waiting = pending.get(message.id)
              if (waiting) {
                pending.delete(message.id)
                if (message.error) {
                  waiting.reject(new Error(typeof message.error.message === 'string'
                    ? message.error.message
                    : 'Codex app-server 请求失败'))
                } else {
                  waiting.resolve(message.result)
                }
              }
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        }
        newline = stdout.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000) })
    child.on('error', (error) => finish(new Error(`无法启动 Codex: ${error.message}`)))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Codex app-server 退出 (${code ?? 'unknown'}): ${stderr.trim()}`))
    })
    const timer = setTimeout(() => finish(new Error('Codex app-server 请求超时')), 30_000)
    void (async () => {
      await request('initialize', {
        clientInfo: { name: 'tabtin-codex-session-import', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      send({ method: 'initialized', params: {} })
      finish(undefined, await operation(request))
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

async function readCodexSessionName(sessionId: string): Promise<string | null> {
  return withCodexAppServer(async (request) => {
    const result = await request<{ thread?: { name?: unknown } }>('thread/read', {
      threadId: sessionId,
      includeTurns: false,
    })
    return typeof result.thread?.name === 'string' ? result.thread.name.trim() || null : null
  })
}

async function unarchiveCodexSession(sessionId: string): Promise<void> {
  await withCodexAppServer(async (request) => {
    const result = await request<{ thread?: { path?: unknown } }>('thread/read', {
      threadId: sessionId,
      includeTurns: false,
    })
    if (typeof result.thread?.path === 'string'
      && result.thread.path.includes(`${path.sep}archived_sessions${path.sep}`)) {
      await request('thread/unarchive', { threadId: sessionId })
    }
  })
}

export function parseCodexGlobalProjects(state: unknown): CodexGlobalProject[] {
  if (!state || typeof state !== 'object') return []
  const projects = (state as Record<string, unknown>)['local-projects']
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return []
  return Object.entries(projects).flatMap(([id, value]) => {
    if (!value || typeof value !== 'object') return []
    const project = value as Record<string, unknown>
    const name = typeof project.name === 'string' ? project.name.trim() : ''
    const rootPaths = Array.isArray(project.rootPaths)
      ? project.rootPaths.filter((root): root is string => (
          typeof root === 'string' && path.isAbsolute(root)
        ))
      : []
    return name && rootPaths.length > 0
      ? [{
          id,
          name,
          rootPaths,
          createdAt: typeof project.createdAt === 'number' ? project.createdAt : 0,
        }]
      : []
  }).sort((left, right) => right.createdAt - left.createdAt)
}

export async function listCodexLocalProjects(): Promise<CodexLocalProject[]> {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const state = JSON.parse(await fs.readFile(
    path.join(codexHome, '.codex-global-state.json'),
    'utf8',
  )) as unknown
  const projects: CodexLocalProject[] = []
  for (const project of parseCodexGlobalProjects(state)) {
    for (const root of project.rootPaths) {
      try {
        const resolved = await fs.realpath(root)
        if ((await fs.stat(resolved)).isDirectory()) {
          projects.push({ id: project.id, name: project.name, path: resolved })
          break
        }
      } catch {
        // A multi-root Codex Project may still have another available root.
      }
    }
  }
  return projects
}

export function assignCodexThreadToProject(
  state: unknown,
  sessionId: string,
  projectId: string,
  cwd: string,
): Record<string, unknown> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Codex Project 状态无效')
  }
  const next = state as Record<string, unknown>
  const projects = next['local-projects']
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)
    || !(projectId in projects)) {
    throw new Error('选择的 Codex Project 已不存在')
  }
  const currentAssignments = next['thread-project-assignments']
  const assignments = currentAssignments && typeof currentAssignments === 'object'
    && !Array.isArray(currentAssignments)
    ? currentAssignments as Record<string, unknown>
    : {}
  next['thread-project-assignments'] = {
    ...assignments,
    [sessionId]: {
      projectKind: 'local',
      projectId,
      cwd,
      pendingCoreUpdate: false,
    },
  }
  return next
}

async function persistCodexProjectAssignment(
  sessionId: string,
  projectId: string,
  cwd: string,
): Promise<void> {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const statePath = path.join(codexHome, '.codex-global-state.json')
  const stateStat = await fs.stat(statePath)
  const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown
  const project = parseCodexGlobalProjects(state).find((candidate) => candidate.id === projectId)
  if (!project) throw new Error('选择的 Codex Project 已不存在')
  const belongsToProject = await Promise.all(project.rootPaths.map(async (root) => {
    try {
      return await fs.realpath(root) === cwd
    } catch {
      return false
    }
  }))
  if (!belongsToProject.some(Boolean)) throw new Error('选择的目录不属于该 Codex Project')

  const next = assignCodexThreadToProject(state, sessionId, projectId, cwd)
  const temporaryPath = `${statePath}.tabtin-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(next), { mode: stateStat.mode })
    await fs.rename(temporaryPath, statePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

async function forkCodexSession(sourcePath: string, title: string, cwd: string): Promise<{
  sessionId: string
  importedPath: string
}> {
  return withCodexAppServer(async (request) => {
    const result = await request<{ thread?: { id?: unknown; path?: unknown } }>('thread/fork', {
      threadId: '',
      path: sourcePath,
      cwd,
      ephemeral: false,
      excludeTurns: true,
    })
    const thread = result.thread
    if (!thread || typeof thread.id !== 'string' || !UUID_RE.test(thread.id)) {
      throw new Error('Codex 返回了无效的 Session ID')
    }
    if (typeof thread.path === 'string'
      && thread.path.includes(`${path.sep}archived_sessions${path.sep}`)) {
      await request('thread/unarchive', { threadId: thread.id })
    }
    await request('thread/name/set', { threadId: thread.id, name: title })
    return {
      sessionId: thread.id,
      importedPath: typeof thread.path === 'string' ? thread.path : '',
    }
  })
}

async function resolveLocalProjectPath(projectPath: string): Promise<string> {
  const selected = path.isAbsolute(projectPath)
    ? projectPath
    : resolveCodexProjectSelection(projectPath, await listCodexLocalProjects())
  const resolved = await fs.realpath(selected)
  const stat = await fs.stat(resolved)
  if (!stat.isDirectory()) throw new Error('选择的 Codex Project 不是目录')
  return resolved
}

async function openCodexProject(projectPath: string): Promise<void> {
  const executable = await resolveCodexExecutable()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['app', projectPath], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`无法打开 Codex 共享会话区 (${code ?? 'unknown'})`)))
  })
}

export async function openCodexSession(
  sessionId: string,
  projectPath: string,
  projectId?: string,
): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error('Codex session ID 无效')
  const resolvedProjectPath = await resolveLocalProjectPath(projectPath)
  await unarchiveCodexSession(sessionId)
  await openCodexProject(resolvedProjectPath)
  if (projectId) {
    await persistCodexProjectAssignment(sessionId, projectId, resolvedProjectPath)
  }
  await refreshRunningCodexSession(sessionId)
  await shell.openExternal(`codex://threads/${sessionId}`)
}

export async function readCodexSessionForShare(sessionId: string): Promise<CodexSessionShareFile> {
  const session = await requireAuthoritativeSession(sessionId)
  const stat = await fs.lstat(session.sourcePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex session 文件无效')
  if (stat.size > CODEX_SESSION_SHARE_MAX_BYTES) {
    throw new Error('Codex session 超过 50 MB，暂不支持通过 IM 发送')
  }
  const data = await fs.readFile(session.sourcePath)
  const firstLineEnd = data.indexOf(0x0a)
  const header = parseCodexSessionShareHeader(
    data.subarray(0, firstLineEnd >= 0 ? firstLineEnd : data.length).toString('utf8'),
  )
  if (header.sessionId !== sessionId) throw new Error('Codex session 文件与索引不一致')
  const title = resolveCodexSessionShareTitle(
    session.title,
    await readCodexSessionName(sessionId),
    sessionId,
  )
  return {
    sessionId,
    title,
    fileName: `${safeFileStem(title)}.codex-session.jsonl`,
    size: data.byteLength,
    buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  }
}

async function extractCodexSessionArchiveEntry(archive: Buffer, allowNestedZip: boolean): Promise<Buffer> {
  const zip = await JSZip.loadAsync(archive)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length !== 1) throw new Error('Codex session 压缩包必须只包含一个文件')
  const entry = entries[0]
  const extension = path.extname(entry.name).toLowerCase()
  if (path.basename(entry.name) !== entry.name || (extension !== '.jsonl' && extension !== '.zip')) {
    throw new Error('Codex session 压缩包内容无效')
  }
  const declaredSize = (entry as typeof entry & {
    _data?: { uncompressedSize?: number }
  })._data?.uncompressedSize
  if (typeof declaredSize !== 'number' || declaredSize > CODEX_SESSION_SHARE_MAX_BYTES) {
    throw new Error('Codex session 解压后超过 50 MB')
  }
  const data = await entry.async('nodebuffer')
  if (data.byteLength > CODEX_SESSION_SHARE_MAX_BYTES) {
    throw new Error('Codex session 解压后超过 50 MB')
  }
  if (extension === '.zip') {
    if (!allowNestedZip) throw new Error('Codex session 压缩包内容无效')
    return extractCodexSessionArchiveEntry(data, false)
  }
  return data
}

export async function extractCodexSessionArchive(archive: Buffer): Promise<Buffer> {
  return extractCodexSessionArchiveEntry(archive, true)
}

export async function importCodexSessionFile(input: {
  filePath: string
  projectId: string
  projectPath: string
  expectedSessionId?: string
  expectedSessionName?: string
}): Promise<{ sessionId: string; importedPath: string; alreadyImported: boolean }> {
  if (!path.isAbsolute(input.filePath) || path.extname(input.filePath).toLowerCase() !== '.zip') {
    throw new Error('请选择已下载的 Codex session ZIP 文件')
  }
  const projectPath = await resolveLocalProjectPath(input.projectPath)
  const sourceStat = await fs.lstat(input.filePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('Codex session 文件无效')
  if (sourceStat.size > CODEX_SESSION_SHARE_MAX_BYTES) throw new Error('Codex session 超过 50 MB')

  const data = await extractCodexSessionArchive(await fs.readFile(input.filePath))
  const firstLineEnd = data.indexOf(0x0a)
  const header = parseCodexSessionShareHeader(
    data.subarray(0, firstLineEnd >= 0 ? firstLineEnd : data.length).toString('utf8'),
  )
  if (input.expectedSessionId && header.sessionId !== input.expectedSessionId) {
    throw new Error('下载文件与消息中的 Codex session 不一致')
  }

  const indexed = indexScanSessions('codex', await scanCodexSessions())
  const alreadyImported = indexed.has(header.sessionId)
  const baseTitle = input.expectedSessionName?.trim() || header.sessionId
  const title = alreadyImported
    ? nextImportedSessionTitle(baseTitle, Array.from(indexed.values(), (session) => session.title))
    : baseTitle
  const stagingDir = await fs.mkdtemp(path.join(tmpdir(), 'tabtin-codex-import-'))
  const stagingPath = path.join(stagingDir, `${header.sessionId}.jsonl`)
  try {
    await fs.writeFile(stagingPath, rewriteCodexSessionCwd(data, projectPath), {
      flag: 'wx',
    })
    const imported = await forkCodexSession(stagingPath, title, projectPath)
    await openCodexSession(imported.sessionId, projectPath, input.projectId)
    return { ...imported, alreadyImported }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true })
  }
}
