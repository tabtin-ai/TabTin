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
const LOG_TAG = '[Skills Installation]'

export interface SkillRegistryPort {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }>
}

export interface SkillInstallationContext {
  registry: SkillRegistryPort
  requireUserId(): string
}

export class SkillRegistryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly responseData: unknown,
    message: string,
  ) {
    super(message)
    this.name = 'SkillRegistryRequestError'
  }
}

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
  requireUserId: () => string
}): Promise<void> {
  const slug = params.skillKey.includes(':')
    ? params.skillKey.split(':').slice(1).join(':')
    : params.skillKey
  // （硬切）：新布局 organization skills；缺 organizationId 时落到
  // user skills，缺 userId 直接失败（不再 `_unscoped`）。
  const userId = params.requireUserId()
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

export async function importSkill(params: {
  input: { spaceId: string; url?: string; sourcePath?: string; name?: string; enable?: boolean }
  organizationId: string | null
  context: SkillInstallationContext
}): Promise<{ data: any; enableError?: string }> {
  const { input, organizationId, context } = params
  const { spaceId } = input
  if (!spaceId) throw new Error('缺少有效的 space_id')

  const prepared = await prepareSkillImportSource({
    spaceId,
    url: input.url ?? '',
    sourcePath: input.sourcePath ?? '',
    name: input.name,
  })

  const result = await context.registry.request('POST', '/api/skills/import', prepared.djangoBody)
  if (result.status < 200 || result.status >= 300) {
    throw new SkillRegistryRequestError(
      result.status,
      result.data,
      extractDjangoErrorMessage(result.data) || `import HTTP ${result.status}`,
    )
  }

  const data = unwrapDjangoData(result.data)
  const skillKey = String(data?.skill_key || data?.skill_id || '')
  const files = prepared.localFiles ?? (Array.isArray(data?.normalized_files) ? data.normalized_files : [])
  await tryMaterializeImportedSkill(skillKey, files, organizationId, spaceId, Boolean(data?.already_exists), context.requireUserId)
  let enableError: string | undefined
  if (input.enable !== false && skillKey) {
    const enableResult = await context.registry.request('POST', `/api/skills/${encodeURIComponent(skillKey)}/enable`, { space_id: spaceId })
    if (enableResult.status < 200 || enableResult.status >= 300) {
      enableError = unwrapDjangoData(enableResult.data)?.message ?? `enable HTTP ${enableResult.status}`
    }
  }
  return { data: { ...data, enabled: input.enable !== false && Boolean(skillKey) && !enableError }, enableError }
}

async function tryMaterializeImportedSkill(skillKey: string, files: SkillImportFileEntry[], organizationId: string | null, spaceId: string, onlyIfMissing: boolean, requireUserId: () => string): Promise<void> {
  if (!skillKey || files.length === 0) return
  try {
    await materializeFilesToSpace({ organizationId: organizationId ?? undefined, spaceId, skillKey, files, onlyIfMissing, requireUserId })
  } catch (err) { console.warn(`${LOG_TAG} materialize failed:`, err) }
}

async function prepareSkillImportSource(options: {
  spaceId: string; url: string; sourcePath: string; name?: string
}): Promise<{ djangoBody: Record<string, unknown>; localFiles: SkillImportFileEntry[] | null }> {
  const base = { space_id: options.spaceId }
  if (options.url) {
    if (!options.url.startsWith('https://')) throw new Error('仅支持 HTTPS URL')
    return { djangoBody: { ...base, url: options.url, ...(options.name ? { name: options.name } : {}) }, localFiles: null }
  }
  if (!options.sourcePath) throw new Error('请提供 path（本地目录/SKILL.md）或 url（HTTPS）')
  const collected = await collectSkillImportFiles(options.sourcePath)
  try {
    return { djangoBody: { ...base, name: options.name || collected.name, files: collected.files }, localFiles: collected.files }
  } finally {
    await collected.cleanup?.()
  }
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

function isNoisyNpmWarnLine(line: string): boolean {
  return /npm warn Unknown (?:env|project) config/i.test(line)
    || /This will stop working in the next major version of npm/i.test(line)
    || /See `npm help npmrc`/i.test(line)
}

function tokenizeSkillsAddArgs(raw: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens.filter(Boolean)
}

export interface ParsedSkillsAddInput {
  source: string
  skills: string[]
}

/**
 * 解析面板 / CLI 输入：支持包名、GitHub URL，以及用户粘贴的整段
 * `npx skills add <source> --skill foo`。
 */
export function parseSkillsAddInput(raw: unknown): ParsedSkillsAddInput {
  let text = String(raw ?? '').trim()
  text = text.replace(/^npm:/i, '').trim()
  text = text.replace(/^(?:npx\s+)?(?:--yes\s+)?skills\s+add\s+/i, '').trim()

  const tokens = tokenizeSkillsAddArgs(text)
  const skills: string[] = []
  const positional: string[] = []
  const ignoredFlags = new Set(['-y', '--yes', '-g', '--global', '--all', '--copy', '-l', '--list'])
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--skill' || tok === '-s') {
      const next = tokens[i + 1]
      if (next && !next.startsWith('-')) {
        skills.push(next)
        i += 1
      }
      continue
    }
    if (tok.startsWith('--skill=')) {
      const value = tok.slice('--skill='.length).trim()
      if (value) skills.push(value)
      continue
    }
    if (ignoredFlags.has(tok)) continue
    if (tok.startsWith('-')) continue
    positional.push(tok.replace(/^npm:/i, ''))
  }

  return {
    source: (positional[0] || '').trim(),
    skills: [...new Set(skills.map((s) => s.trim()).filter(Boolean))],
  }
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
      // 去掉冗长 npm warn，优先露出 skills CLI 真实错误
      const cleaned = detail
        .split('\n')
        .filter((line) => !isNoisyNpmWarnLine(line))
        .join('\n')
        .trim()
      reject(new Error(
        `npx skills add 失败（exit ${code}）: ${cleaned || source}`,
      ))
    })
  })
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

export function normalizeNpmPackageName(raw: unknown): string {
  return parseSkillsAddInput(raw).source
}

export interface InstallNpmSkillResult {
  package: string
  agents_skills_dir: string
  discovered_slugs: string[]
  imported: unknown[]
  note?: string
}

function firstDefined(body: any, fields: readonly string[]): unknown {
  for (const field of fields) {
    if (body?.[field] !== undefined && body[field] !== null) return body[field]
  }
  return undefined
}

async function importSkillDirsToSpace(options: {
  skillRoot: string
  slugs: string[]
  spaceId: string
  organizationId?: string | null
  enableSpaceIds?: string[]
  context: SkillInstallationContext
}): Promise<{ imported: unknown[]; errors: string[]; notes: string[] }> {
  const imported: unknown[] = []
  const errors: string[] = []
  const notes: string[] = []
  const { items, slugByIndex } = await collectSkillImportItems(options, errors)

  if (items.length === 0) {
    return { imported, errors, notes }
  }

  const result = await options.context.registry.request('POST', '/api/skills/import', { space_id: options.spaceId, items })
  if (result.status < 200 || result.status >= 300) {
    const importErr = extractDjangoErrorMessage(result.data)
      || `import HTTP ${result.status}`
    for (const slug of slugByIndex) {
      errors.push(`${slug}: ${importErr}`)
    }
    return { imported, errors, notes }
  }

  const rows = normalizeSkillImportRows(unwrapDjangoData(result.data))
  await materializeSkillImportRows(rows, items, slugByIndex, options, imported, errors)

  return { imported, errors, notes }
}

interface SkillImportItem { name?: string; files: SkillImportFileEntry[]; enable_space_ids?: string[] }

async function collectSkillImportItems(options: { skillRoot: string; slugs: string[]; enableSpaceIds?: string[] }, errors: string[]): Promise<{ items: SkillImportItem[]; slugByIndex: string[] }> {
  const items: SkillImportItem[] = []
  const slugByIndex: string[] = []
  for (const slug of options.slugs) {
    try {
      const collected = await collectSkillImportFiles(path.join(options.skillRoot, slug))
      items.push({ name: collected.name, files: collected.files, ...(options.enableSpaceIds?.length ? { enable_space_ids: options.enableSpaceIds } : {}) })
      slugByIndex.push(slug)
    } catch (err) {
      errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { items, slugByIndex }
}

function normalizeSkillImportRows(data: any): any[] {
  const rows = Array.isArray(data?.results) ? data.results : []
  if (rows.length === 0 && (data?.skill_key || data?.skill_id)) {
    rows.push({ index: 0, ok: true, already_exists: Boolean(data?.already_exists), skill: data, normalized_files: data?.normalized_files })
  }
  return rows
}

async function materializeSkillImportRows(rows: any[], items: SkillImportItem[], slugByIndex: string[], options: { spaceId: string; organizationId?: string | null; context: SkillInstallationContext }, imported: unknown[], errors: string[]): Promise<void> {
  for (const row of rows) {
    await materializeSkillImportRow(row, items, slugByIndex, options, imported, errors)
  }
}

async function materializeSkillImportRow(row: any, items: SkillImportItem[], slugByIndex: string[], options: { spaceId: string; organizationId?: string | null; context: SkillInstallationContext }, imported: unknown[], errors: string[]): Promise<void> {
  const normalized = normalizeSkillImportRow(row, items, slugByIndex)
  if (!normalized.ok) { errors.push(normalized.error); return }
  await tryMaterializeImportedSkill(normalized.skillKey, normalized.files, options.organizationId ?? null, options.spaceId, normalized.alreadyExists, options.context.requireUserId)
  imported.push({ ...normalized.skillData, already_exists: normalized.alreadyExists })
}

function normalizeSkillImportRow(row: any, items: SkillImportItem[], slugByIndex: string[]):
  | { ok: false; error: string }
  | { ok: true; skillData: any; skillKey: string; files: SkillImportFileEntry[]; alreadyExists: boolean } {
  const idx = Number(row?.index ?? -1)
  const slug = slugByIndex[idx] || `item-${idx}`
  if (!row?.ok) return { ok: false, error: `${slug}: ${skillImportRowError(row)}` }
  const skillData = row.skill ?? row
  return {
    ok: true,
    skillData,
    skillKey: String(firstDefined(skillData, ['skill_key', 'skill_id']) ?? ''),
    files: normalizedImportFiles(row, items[idx]),
    alreadyExists: Boolean(row.already_exists ?? skillData?.already_exists),
  }
}

function skillImportRowError(row: any): string {
  return typeof row?.error?.message === 'string' ? row.error.message : '导入失败'
}

function normalizedImportFiles(row: any, item?: SkillImportItem): SkillImportFileEntry[] {
  return Array.isArray(row.normalized_files) && row.normalized_files.length > 0
    ? row.normalized_files
    : (item?.files ?? [])
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
  context: SkillInstallationContext
}): Promise<InstallNpmSkillResult> {
  const parsed = parseSkillsAddInput(options.packageName)
  const packageName = parsed.source
  if (!packageName) {
    throw new Error('请提供 npm 包名或 GitHub 源（如 owner/repo、https://github.com/...）')
  }

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
          context: options.context,
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

export function resolveHomeAgentsSkillsDir(): string {
  return resolveDefaultAgentsSkillsDir(process.env, () => os.homedir())
}
