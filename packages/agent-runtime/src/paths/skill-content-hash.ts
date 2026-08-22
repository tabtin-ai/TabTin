/**
 * D11 Skill 内容 hash 算法（PRD V3.3 / W0 决策 4 V2）TypeScript 镜像。
 *
 *  Stage 6a：自 `@tabtin/terminal-core` 迁入 agent-runtime。
 * 与 Python 端 `apps/tabtin_django/apps/skills/services/content_hash.py` 字面对齐：
 *
 * 1. 扫描 skill 目录，递归收集所有非 ignore 文件
 * 2. 对每个文件按规范化内容算 SHA-256
 * 3. 用 PR `compute_bundle_sha256` 算法计算 Merkle root：把
 *    `[(relpath, sha256), ...]` 按 path 排序后整体 SHA-256
 *
 * 规范化内容：
 * - 行尾统一为 LF（剥离 CRLF / CR）
 * - 剥离 UTF-8 BOM
 * - 文件路径用 POSIX 分隔符（避免 Windows 反斜杠）
 *
 * Ignore 列表（PR client + user 场景扩充 11 项 — 与 Python 端 `_IGNORED_*` 对齐）。
 *
 * 调用位置（Wave 1 起）：
 * - Electron 主进程 SkillDirWatcher onChange 回调，debounce 500ms
 * - IPC push 给渲染进程，更新详情区"本地有未发布改动"标记
 *
 * 黄金测试：构造已知 skill 文件夹 → 期望 hash 与 Python 端 `compute_bundle_sha256`
 * 完全一致。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep, posix } from 'node:path'

const IGNORED_DIRS = new Set([
  '__pycache__', '.git', 'node_modules', '.tox', '.mypy_cache',
  '.pytest_cache', '.eggs', 'dist', 'build',
  '.idea', '.vscode', '.cursor', '.history',
  '.fseventsd', '.Spotlight-V100', '.Trashes', '.Trash',
])

const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitkeep',
  'desktop.ini', 'Icon\r',
])

const IGNORED_SUFFIXES: readonly string[] = [
  '.pyc', '.pyo', '.egg-info', '.so', '.dylib',
  '.swp', '.swo', '.swn',
  '~',
]

function isIgnoredFilename(name: string): boolean {
  if (IGNORED_FILES.has(name)) return true
  // emacs autosave: #FILE#
  if (name.startsWith('#') && name.endsWith('#') && name.length > 2) return true
  for (const suffix of IGNORED_SUFFIXES) {
    if (name.endsWith(suffix)) return true
  }
  return false
}

function normalizeContent(raw: Buffer): Buffer {
  let buf = raw
  // 剥 UTF-8 BOM（首 3 字节 0xEF 0xBB 0xBF）
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3)
  }
  // CRLF → LF；剩余孤立 CR → LF
  // 不做单次大替换以避免分配过多中间 buffer；按字节扫一次产出新 buffer。
  const out: number[] = []
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0x0d) {
      // 0x0d = '\r'。下一个是 '\n' → 已经覆盖到 \n，跳过本字节
      if (i + 1 < buf.length && buf[i + 1] === 0x0a) {
        continue
      }
      // 孤立 CR → LF
      out.push(0x0a)
    } else {
      out.push(b)
    }
  }
  return Buffer.from(out)
}

function hashFileSync(absPath: string): string {
  const raw = readFileSync(absPath)
  const normalized = normalizeContent(raw)
  return createHash('sha256').update(normalized).digest('hex')
}

async function hashFile(absPath: string): Promise<string> {
  const raw = await readFile(absPath)
  const normalized = normalizeContent(raw)
  return createHash('sha256').update(normalized).digest('hex')
}

function toPosixRel(absPath: string, root: string): string {
  const rel = relative(root, absPath)
  // Windows 路径分隔符 → POSIX
  if (sep === posix.sep) return rel
  return rel.split(sep).join(posix.sep)
}

interface FileEntry {
  posixRelPath: string
  sha256: string
}

function merkleRoot(entries: FileEntry[]): string {
  // 与 Python `compute_bundle_sha256` 完全对齐：按 path 排序 + 拼 "path:sha"
  const sorted = [...entries].sort((a, b) =>
    a.posixRelPath < b.posixRelPath ? -1 : a.posixRelPath > b.posixRelPath ? 1 : 0,
  )
  const hasher = createHash('sha256')
  for (const e of sorted) {
    hasher.update(`${e.posixRelPath}:${e.sha256}`)
  }
  return hasher.digest('hex')
}

/**
 * 异步计算 skill 目录内容 hash。
 *
 * @param skillDir skill 目录绝对路径
 * @returns hex SHA-256，与 Python `compute_skill_content_hash` 字面对齐
 */
export async function computeSkillContentHash(skillDir: string): Promise<string> {
  const entries: FileEntry[] = []
  await walk(skillDir, skillDir, entries)
  return merkleRoot(entries)
}

async function walk(currentDir: string, root: string, entries: FileEntry[]): Promise<void> {
  let items: Array<{ name: string; isDir: boolean; isFile: boolean }> = []
  try {
    const dirents = await readdir(currentDir, { withFileTypes: true })
    items = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isFile: d.isFile(),
    }))
  } catch {
    return
  }
  for (const item of items) {
    const abs = join(currentDir, item.name)
    if (item.isDir) {
      if (IGNORED_DIRS.has(item.name)) continue
      await walk(abs, root, entries)
    } else if (item.isFile) {
      if (isIgnoredFilename(item.name)) continue
      try {
        const sha = await hashFile(abs)
        entries.push({ posixRelPath: toPosixRel(abs, root), sha256: sha })
      } catch {
        // 不可读文件忽略（与 Python 端语义一致）
      }
    }
  }
}

/**
 * 同步版本（测试 / CLI 用），优先使用异步 `computeSkillContentHash`。
 */
export function computeSkillContentHashSync(skillDir: string): string {
  const entries: FileEntry[] = []
  walkSync(skillDir, skillDir, entries)
  return merkleRoot(entries)
}

function walkSync(currentDir: string, root: string, entries: FileEntry[]): void {
  // 历史坑（2026-05 修）：这里曾写成 `require('node:fs').readdirSync(...)`。
  // electron 主进程现在是纯 ESM bundle（electron-vite `format: 'es'`），
  // ESM 上下文里没有 `require` 全局，运行时直接抛 ReferenceError。
  // 改用顶部 ESM import 的 `readdirSync` —— Node CJS / ESM、esbuild bundle、
  // tsup ESM/CJS 双轨都安全。
  let items: { name: string; isDir: boolean; isFile: boolean }[] = []
  try {
    const dirents = readdirSync(currentDir, { withFileTypes: true })
    items = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isFile: d.isFile(),
    }))
  } catch {
    return
  }
  for (const item of items) {
    const abs = join(currentDir, item.name)
    if (item.isDir) {
      if (IGNORED_DIRS.has(item.name)) continue
      walkSync(abs, root, entries)
    } else if (item.isFile) {
      if (isIgnoredFilename(item.name)) continue
      try {
        const sha = hashFileSync(abs)
        entries.push({ posixRelPath: toPosixRel(abs, root), sha256: sha })
      } catch {
        // ignore unreadable file
      }
    }
  }
}
