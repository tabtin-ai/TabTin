/**
 * CLI Skill 本地导入 / npm 安装
 *
 * - POST /skills/import：本地路径 / zip / https → Django import + 本地物化
 * - POST /skills/install-npm：npx skills add → ~/.agents/skills，刷新本机 registry
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { resolveDefaultAgentsSkillsDir } from '@tabtin/agent-host/skills'
import {
  resolveDataRoot,
  resolveOrganizationSkillDir,
  resolveUserSkillDir,
} from '@tabtin/terminal-core'
import { TokenManager } from '../../auth'
import { djangoRequest, errorResponse } from './shared/error-handler'
import type { SendJSON } from './shared/error-handler'
import http from 'node:http'
import {
  assertValidSkillsAddSource,
  formatNpxSkillsAddFailure,
  isTransientSkillsAddFailure,
  normalizeNpmPackageName,
  parseSkillsAddInput,
  rewriteGithubBrowserTitle,
  stripAnsi,
  type ParsedSkillsAddInput,
} from './skill-npm-source'

export {
  assertValidSkillsAddSource,
  formatNpxSkillsAddFailure,
  normalizeNpmPackageName,
  parseSkillsAddInput,
  rewriteGithubBrowserTitle,
  stripAnsi,
}
export type { ParsedSkillsAddInput }

const LOG_TAG = '[CLI Skills Import]'

export interface SkillImportFileEntry {
  path: string
  content: string
  encoding?: 'base64'
}

const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.js', '.ts', '.mjs', '.cjs',
  '.py', '.sh', '.css', '.html', '.xml', '.csv', '.svg',
])

function isProbablyText(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  const base = path.basename(filePath)
  return base === 'SKILL.md' || base === 'LICENSE' || !ext
}

async function collectFilesFromDir(
  rootDir: string,
  relativePrefix = '',
): Promise<SkillImportFileEntry[]> {
  const out: SkillImportFileEntry[] = []
  const entries = await fsp.readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(rootDir, entry.name)
    const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await collectFilesFromDir(abs, rel)))
      continue
    }
    if (!entry.isFile()) continue
    if (isProbablyText(abs)) {
      const content = await fsp.readFile(abs, 'utf-8')
      out.push({ path: rel.replace(/\\/g, '/'), content })
    } else {
      const buf = await fsp.readFile(abs)
      out.push({
        path: rel.replace(/\\/g, '/'),
        content: buf.toString('base64'),
        encoding: 'base64',
      })
    }
  }
  return out
}

async function extractZipToTemp(zipPath: string): Promise<string> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tabtin-skill-import-'))
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-q', '-o', zipPath, '-d', tmpRoot], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      reject(
        new Error(
          `无法解压 zip（需要本机 unzip 命令）: ${err.message}`,
        ),
      )
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`unzip 失败（exit ${code}）: ${stderr.trim() || zipPath}`))
    })
  })
  return tmpRoot
}

/** 若 zip 解出单层包装目录，下钻到含 SKILL.md 的实际根。 */
async function resolveExtractedSkillRoot(extractDir: string): Promise<string> {
  const entries = await fsp.readdir(extractDir, { withFileTypes: true })
  const meaningful = entries.filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX')
  try {
    await fsp.access(path.join(extractDir, 'SKILL.md'))
    return extractDir
  } catch {
    // continue
  }
  if (meaningful.length === 1 && meaningful[0].isDirectory()) {
    const nested = path.join(extractDir, meaningful[0].name)
    try {
      await fsp.access(path.join(nested, 'SKILL.md'))
      return nested
    } catch {
      // fall through — still scan nested for nested SKILL.md paths
      return nested
    }
  }
  return extractDir
}

/** 从本地目录或单个 SKILL.md / zip 收集 files[]。 */
export async function collectSkillImportFiles(
  sourcePath: string,
): Promise<{ name: string; files: SkillImportFileEntry[]; cleanup?: () => Promise<void> }> {
  const resolved = path.resolve(sourcePath)
  const stat = await fsp.stat(resolved)
  if (stat.isFile()) {
    if (resolved.toLowerCase().endsWith('.zip')) {
      const extractDir = await extractZipToTemp(resolved)
      const skillRoot = await resolveExtractedSkillRoot(extractDir)
      const files = await collectFilesFromDir(skillRoot)
      if (!files.some((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))) {
        await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {})
        throw new Error(`zip 中未找到 SKILL.md: ${resolved}`)
      }
      const name =
        path.basename(skillRoot) !== path.basename(extractDir)
          ? path.basename(skillRoot)
          : path.basename(resolved, '.zip') || 'imported-skill'
      return {
        name,
        files,
        cleanup: async () => {
          await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {})
        },
      }
    }
    if (path.basename(resolved) !== 'SKILL.md') {
      throw new Error('本地文件导入仅支持 SKILL.md / .zip，或传入含 SKILL.md 的目录')
    }
    const content = await fsp.readFile(resolved, 'utf-8')
    const name = path.basename(path.dirname(resolved)) || 'imported-skill'
    return { name, files: [{ path: 'SKILL.md', content }] }
  }
  if (!stat.isDirectory()) {
    throw new Error(`路径不是文件或目录: ${resolved}`)
  }
  const files = await collectFilesFromDir(resolved)
  if (!files.some((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))) {
    throw new Error(`目录中未找到 SKILL.md: ${resolved}`)
  }
  const name = path.basename(resolved) || 'imported-skill'
  return { name, files }
}

function unwrapDjangoData(djangoData: any): any {
  return djangoData?.data ?? djangoData
}

function extractDjangoErrorMessage(djangoData: any): string {
  const root = djangoData && typeof djangoData === 'object' ? djangoData : null
  const data = unwrapDjangoData(root)
  const candidates = [
    data?.detail,
    data?.message,
    root?.message,
    root?.error?.message,
    typeof data === 'string' ? data : null,
  ]
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return ''
}

function peekSkillMeta(files: SkillImportFileEntry[]): { name?: string; description?: string } {
  const md = files.find((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
  if (!md || md.encoding === 'base64' || typeof md.content !== 'string') return {}
  const nameMatch = md.content.match(/^name:\s*["']?([^\n"']+)/m)
  const descMatch = md.content.match(/^description:\s*[>|]?\s*["']?([^\n"']+)/m)
  return {
    name: nameMatch?.[1]?.trim() || undefined,
    description: descMatch?.[1]?.trim() || undefined,
  }
}

function normalizeSpaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    /[\x00-\x1F\x7F]/.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

async function materializeFilesToSpace(params: {
  organizationId: string | undefined
  spaceId: string
  skillKey: string
  files: SkillImportFileEntry[]
  /** 已存在时仅在本地缺 SKILL.md 时写入，避免覆盖用户编辑。 */
  onlyIfMissing?: boolean
}): Promise<void> {
  const slug = params.skillKey.includes(':')
    ? params.skillKey.split(':').slice(1).join(':')
    : params.skillKey
  const userInfo = await TokenManager.getUserInfo()
  const rawUserId =
    (userInfo?.id as unknown) ??
    (userInfo?.user_id as unknown) ??
    (userInfo?.userId as unknown)
  if (rawUserId === undefined || rawUserId === null || rawUserId === '' || String(rawUserId) === '_unscoped') {
    throw new Error('未登录：无法解析 userId，拒绝写入本地 skills 目录')
  }
  const userId = String(rawUserId)
  // ：新布局 organization skills；缺 organizationId 时落到 user skills。
  const targetDir = params.organizationId
    ? resolveOrganizationSkillDir(resolveDataRoot(), userId, params.organizationId, slug)
    : resolveUserSkillDir(resolveDataRoot(), userId, slug)
  if (params.onlyIfMissing) {
    try {
      await fsp.access(path.join(targetDir, 'SKILL.md'))
      return
    } catch {
      // 本地缺 SKILL.md，继续物化
    }
  }
  await fsp.mkdir(targetDir, { recursive: true })
  for (const file of params.files) {
    const dest = path.join(targetDir, ...file.path.split('/'))
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    if (file.encoding === 'base64') {
      await fsp.writeFile(dest, Buffer.from(file.content, 'base64'))
    } else {
      await fsp.writeFile(dest, file.content, 'utf-8')
    }
  }
}

export async function handleSkillImport(params: {
  body: any
  organizationId: string | null
  sendJSON: SendJSON
  res: http.ServerResponse
  refreshInterop?: () => Promise<void>
}): Promise<void> {
  const { body, organizationId, sendJSON, res } = params
  const spaceId = normalizeSpaceId(body?.space_id) ?? normalizeSpaceId(body?.spaceId)
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少有效的 space_id'))
    return
  }

  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  const sourcePath = typeof body?.path === 'string' ? body.path.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : undefined
  const enable = body?.enable === true

  let djangoBody: Record<string, unknown> = { space_id: spaceId }
  let localFiles: SkillImportFileEntry[] | null = null
  let importName = name

  try {
    if (url) {
      if (!url.startsWith('https://')) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '仅支持 HTTPS URL'))
        return
      }
      djangoBody = { ...djangoBody, url, ...(importName ? { name: importName } : {}) }
    } else if (sourcePath) {
      const collected = await collectSkillImportFiles(sourcePath)
      try {
        localFiles = collected.files
        importName = importName || collected.name
        djangoBody = {
          ...djangoBody,
          name: importName,
          files: collected.files,
        }
      } finally {
        await collected.cleanup?.()
      }
    } else {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', '请提供 path（本地目录/SKILL.md）或 url（HTTPS）'),
      )
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', msg))
    return
  }

  const result = await djangoRequest('POST', '/api/skills/import', djangoBody, { logTag: LOG_TAG })
  if (result.status < 200 || result.status >= 300) {
    sendJSON(res, result.status, result.data)
    return
  }

  const data = unwrapDjangoData(result.data)
  const skillKey = String(data?.skill_key || data?.skill_id || '')
  const alreadyExists = Boolean(data?.already_exists)
  const filesToMaterialize: SkillImportFileEntry[] =
    localFiles
    ?? (Array.isArray(data?.normalized_files) ? data.normalized_files : [])

  if (skillKey && filesToMaterialize.length > 0) {
    try {
      await materializeFilesToSpace({
        organizationId: organizationId ?? undefined,
        spaceId,
        skillKey,
        files: filesToMaterialize,
        onlyIfMissing: alreadyExists,
      })
    } catch (err) {
      console.warn(`${LOG_TAG} materialize failed:`, err)
    }
  }

  if (enable && skillKey) {
    const enableResult = await djangoRequest(
      'POST',
      `/api/skills/${encodeURIComponent(skillKey)}/enable`,
      { space_id: spaceId },
      { logTag: LOG_TAG },
    )
    if (enableResult.status < 200 || enableResult.status >= 300) {
      sendJSON(res, 200, {
        success: true,
        data: {
          ...data,
          enabled: false,
          enable_error: unwrapDjangoData(enableResult.data)?.message
            ?? `enable HTTP ${enableResult.status}`,
        },
      })
      return
    }
  }

  sendJSON(res, 200, { success: true, data: { ...data, enabled: enable && Boolean(skillKey) } })
}

function scrubNpmSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  options?: { home?: string; userconfig?: string },
): NodeJS.ProcessEnv {
  // Electron / monorepo 常注入非标准 npm_config_*（如 devdir），会让 npx 告警甚至异常退出。
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (/^npm_config_/i.test(key)) delete out[key]
  }
  // 阻断读到仓库根 .npmrc 里的 pnpm 专用键（Unknown project config）
  if (options?.userconfig) {
    out.npm_config_userconfig = options.userconfig
    out.NPM_CONFIG_USERCONFIG = options.userconfig
  }
  if (options?.home) {
    out.HOME = options.home
    if (process.platform === 'win32') out.USERPROFILE = options.home
  }
  // Electron 有时会带上精简 PATH，补常见 Node 路径以免找不到 npx
  const extras = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'node', 'bin')]
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const current = out[pathKey] || out.PATH || ''
  out[pathKey] = [...extras, current].filter(Boolean).join(path.delimiter)
  return out
}

async function runNpxSkillsAddOnce(
  source: string,
  options?: {
    global?: boolean
    cwd?: string
    timeoutMs?: number
    skills?: string[]
  },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 180_000
  const args = ['--yes', 'skills', 'add', source, '-y']
  for (const skill of options?.skills ?? []) {
    args.push('--skill', skill)
  }
  if (options?.global !== false && !options?.cwd) {
    // 默认全局：写入 ~/.agents/skills（CLI 本机互操作）
    args.push('-g')
  } else if (options?.global) {
    args.push('-g')
  }

  // 面板导入用临时目录：空 npmrc + HOME=cwd，避免读到仓库 .npmrc，并让非 -g 安装落到 cwd/.agents
  let userconfig: string | undefined
  let home: string | undefined
  if (options?.cwd) {
    userconfig = path.join(options.cwd, '.npmrc')
    await fsp.writeFile(userconfig, '', 'utf8')
    if (options.global === false) home = options.cwd
  }

  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubNpmSpawnEnv(process.env, { home, userconfig }),
      cwd: options?.cwd,
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`npx skills add 超时（${timeoutMs}ms）: ${source}`))
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').trim()
      reject(new Error(formatNpxSkillsAddFailure(detail, source, code)))
    })
  })
}

async function runNpxSkillsAdd(
  source: string,
  options?: {
    global?: boolean
    cwd?: string
    timeoutMs?: number
    skills?: string[]
  },
): Promise<void> {
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runNpxSkillsAddOnce(source, options)
      return
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (!isTransientSkillsAddFailure(lastErr.message) || attempt === maxAttempts) {
        throw lastErr
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  throw lastErr ?? new Error(`npx skills add 失败: ${source}`)
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    const dirs: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        await fsp.access(path.join(root, entry.name, 'SKILL.md'))
        dirs.push(entry.name)
      } catch {
        // skip
      }
    }
    return dirs.sort()
  } catch {
    return []
  }
}

export interface InstallNpmSkillResult {
  package: string
  agents_skills_dir: string
  discovered_slugs: string[]
  imported: unknown[]
  note?: string
}

async function importSkillDirsToSpace(options: {
  skillRoot: string
  slugs: string[]
  spaceId: string
  organizationId?: string | null
  enableSpaceIds?: string[]
}): Promise<{ imported: unknown[]; errors: string[]; notes: string[] }> {
  const imported: unknown[] = []
  const errors: string[] = []
  const notes: string[] = []
  const items: Array<{
    name?: string
    files: SkillImportFileEntry[]
    enable_space_ids?: string[]
  }> = []
  const slugByIndex: string[] = []

  for (const slug of options.slugs) {
    const dir = path.join(options.skillRoot, slug)
    try {
      const collected = await collectSkillImportFiles(dir)
      items.push({
        name: collected.name,
        files: collected.files,
        ...(options.enableSpaceIds?.length
          ? { enable_space_ids: options.enableSpaceIds }
          : {}),
      })
      slugByIndex.push(slug)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${slug}: ${msg}`)
    }
  }

  if (items.length === 0) {
    return { imported, errors, notes }
  }

  const result = await djangoRequest(
    'POST',
    '/api/skills/import',
    { space_id: options.spaceId, items },
    { logTag: LOG_TAG },
  )
  if (result.status < 200 || result.status >= 300) {
    const importErr = extractDjangoErrorMessage(result.data)
      || `import HTTP ${result.status}`
    for (const slug of slugByIndex) {
      errors.push(`${slug}: ${importErr}`)
    }
    return { imported, errors, notes }
  }

  const data = unwrapDjangoData(result.data)
  const results = Array.isArray(data?.results) ? data.results : []
  if (results.length === 0 && (data?.skill_key || data?.skill_id)) {
    results.push({
      index: 0,
      ok: true,
      already_exists: Boolean(data?.already_exists),
      skill: data,
      normalized_files: data?.normalized_files,
    })
  }

  for (const row of results) {
    const idx = Number(row?.index ?? -1)
    const slug = slugByIndex[idx] || `item-${idx}`
    if (!row?.ok) {
      errors.push(`${slug}: ${row?.error?.message || '导入失败'}`)
      continue
    }
    const skillData = row.skill || row
    const skillKey = String(skillData?.skill_key || skillData?.skill_id || '')
    const filesToWrite: SkillImportFileEntry[] =
      (Array.isArray(row.normalized_files) && row.normalized_files.length > 0
        ? row.normalized_files
        : items[idx]?.files) || []
    if (skillKey && filesToWrite.length > 0) {
      await materializeFilesToSpace({
        organizationId: options.organizationId ?? undefined,
        spaceId: options.spaceId,
        skillKey,
        files: filesToWrite,
        onlyIfMissing: Boolean(row.already_exists || skillData?.already_exists),
      })
    }
    imported.push({
      ...skillData,
      already_exists: Boolean(row.already_exists || skillData?.already_exists),
    })
  }

  return { imported, errors, notes }
}

/**
 * npm / skills 包安装。
 * - importToSpace=true（面板默认）：装到临时目录 → Django import → Space sandbox，不写 ~/.agents/skills
 * - importToSpace=false（CLI 默认）：`npx skills add -g` → ~/.agents/skills 本机发现
 */
export async function installNpmSkill(options: {
  packageName: string
  organizationId?: string | null
  spaceId?: string | null
  importToSpace?: boolean
  enableSpaceIds?: string[]
  addInteropRoot?: (rootPath: string) => Promise<void>
}): Promise<InstallNpmSkillResult> {
  const parsed = parseSkillsAddInput(options.packageName)
  const packageName = parsed.source
  assertValidSkillsAddSource(packageName)

  const importToSpace = Boolean(options.importToSpace)
  const spaceId = normalizeSpaceId(options.spaceId)

  if (importToSpace) {
    if (!spaceId) {
      throw new Error('导入到 Space 需要有效的 space_id')
    }
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tabtin-skill-npm-'))
    try {
      await runNpxSkillsAdd(packageName, {
        cwd: tmpRoot,
        global: false,
        skills: parsed.skills,
      })
      const skillRoot = path.join(tmpRoot, '.agents', 'skills')
      const discovered = await listSkillDirs(skillRoot)
      const { imported, errors, notes } = discovered.length > 0
        ? await importSkillDirsToSpace({
          skillRoot,
          slugs: discovered,
          spaceId,
          organizationId: options.organizationId,
          enableSpaceIds: options.enableSpaceIds,
        })
        : { imported: [] as unknown[], errors: [] as string[], notes: [] as string[] }

      if (discovered.length > 0 && imported.length === 0) {
        throw new Error(
          errors.join('；')
          || '已下载 Skill，但导入到 Space 失败',
        )
      }

      return {
        package: packageName,
        agents_skills_dir: skillRoot,
        discovered_slugs: discovered,
        imported,
        note: discovered.length === 0
          ? '安装完成，但未检测到 SKILL.md；请确认包名 / --skill 是否正确'
          : notes[0]
            || (errors.length > 0
              ? `部分 Skill 导入失败：${errors.join('；')}`
              : undefined),
      }
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const agentsRoot = resolveDefaultAgentsSkillsDir()
  const before = new Set(await listSkillDirs(agentsRoot))
  await runNpxSkillsAdd(packageName, { global: true, skills: parsed.skills })

  if (options.addInteropRoot) {
    try {
      await options.addInteropRoot(agentsRoot)
    } catch (err) {
      console.warn(`${LOG_TAG} refresh interop failed:`, err)
    }
  }

  const after = await listSkillDirs(agentsRoot)
  const discovered = after.filter((name) => !before.has(name))

  return {
    package: packageName,
    agents_skills_dir: agentsRoot,
    discovered_slugs: discovered,
    imported: [],
    note: discovered.length === 0
      ? '安装完成，但未检测到新的 SKILL.md 目录；请检查包是否写入 ~/.agents/skills'
      : undefined,
  }
}

export async function handleSkillInstallNpm(params: {
  body: any
  organizationId: string | null
  sendJSON: SendJSON
  res: http.ServerResponse
  addInteropRoot?: (rootPath: string) => Promise<void>
  importToSpace?: boolean
}): Promise<void> {
  const { body, organizationId, sendJSON, res, addInteropRoot } = params
  // 保留原始输入（含 --skill），由 installNpmSkill / parseSkillsAddInput 解析
  const rawPackage = String(body?.package ?? body?.npm ?? body?.skill_key ?? '')
  try {
    assertValidSkillsAddSource(parseSkillsAddInput(rawPackage).source)
  } catch (err) {
    sendJSON(res, 400, errorResponse(
      'VALIDATION_ERROR',
      err instanceof Error
        ? err.message
        : '请提供源地址（如 https://github.com/owner/repo --skill foo，或 npm:@scope/pkg）',
    ))
    return
  }

  try {
    const data = await installNpmSkill({
      packageName: rawPackage,
      organizationId,
      spaceId: normalizeSpaceId(body?.space_id) ?? normalizeSpaceId(body?.spaceId),
      importToSpace: Boolean(body?.import_to_space ?? body?.importToSpace ?? params.importToSpace),
      addInteropRoot,
    })
    sendJSON(res, 200, { success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', msg, {
      suggestions: [
        '确认本机已安装 Node.js / npx',
        '检查网络是否可访问 npm registry / GitHub',
        '包名是否正确（可先手动试：npx skills add <pkg> -y）',
      ],
    }))
  }
}

export function resolveHomeAgentsSkillsDir(): string {
  return resolveDefaultAgentsSkillsDir(process.env, () => os.homedir())
}
