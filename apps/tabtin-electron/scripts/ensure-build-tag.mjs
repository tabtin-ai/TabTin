#!/usr/bin/env node
/**
 * GitFlow alpha tag 工具（解析 + 构建前 ensure）。
 *
 * ensure 规则（pack / 打包默认）：
 *   - HEAD 上已有 *-alpha.* tag → 复用最高版本，不新建
 *   - HEAD commit 与上次构建相同（等价于上一条）→ 不递增
 *   - 新 commit → 在 HEAD 打递增的 alpha.N tag
 *
 * 全局唯一计数器（syncRemote，CLI 默认开）：
 *   origin 是版本号的唯一权威。取号前必须 `git fetch` 远端 tag、建号后 `git push`，
 *   多台打包机共享同一序列、不会各算各的而漂移/撞号。若 push 时该号已被别的
 *   打包机抢占 → 删本地号、refetch、自动 +1 重试。离线 / 不想推 → PACK_SKIP_TAG_PUSH=1。
 *
 * CLI:
 *   node scripts/ensure-build-tag.mjs          # ensure 并 stdout 输出版本
 *   node scripts/resolve-build-tag.mjs         # 只读解析（dev 展示用，薄封装）
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, '../../..')
export const ALPHA_TAG_GLOB = '*-alpha.*'
export const DEFAULT_REMOTE = process.env.PACK_GIT_REMOTE || 'origin'
const DEFAULT_FETCH_MAX_ATTEMPTS = 3
const DEFAULT_FETCH_RETRY_DELAY_MS = 2000
const PACKAGE_JSON_PATH = resolve(__dirname, '..', 'package.json')

function parseIntegerEnv(value, fallback, { min = 0 } = {}) {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

function defaultFetchMaxAttempts() {
  return parseIntegerEnv(
    process.env.PACK_TAG_FETCH_RETRIES ?? process.env.PACK_GIT_FETCH_RETRIES,
    DEFAULT_FETCH_MAX_ATTEMPTS,
    { min: 1 },
  )
}

function defaultFetchRetryDelayMs() {
  if (process.env.PACK_TAG_FETCH_RETRY_DELAY_MS) {
    return parseIntegerEnv(process.env.PACK_TAG_FETCH_RETRY_DELAY_MS, DEFAULT_FETCH_RETRY_DELAY_MS)
  }
  return parseIntegerEnv(
    process.env.PACK_GIT_FETCH_RETRY_DELAY_SECONDS,
    DEFAULT_FETCH_RETRY_DELAY_MS / 1000,
  ) * 1000
}

function sleepSync(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function formatRetryDelay(ms) {
  if (ms <= 0) return ''
  if (ms % 1000 === 0) return `${ms / 1000} 秒后`
  return `${ms}ms 后`
}

export function isRetryableGitFetchError(stderr) {
  const detail = String(stderr ?? '')
  if (!detail) return false

  if (/cannot lock ref/i.test(detail) && /but expected/i.test(detail)) {
    return true
  }

  return [
    /Failed to connect to/i,
    /Could not connect to server/i,
    /Could not resolve host/i,
    /Connection timed out/i,
    /Operation timed out/i,
    /Connection reset/i,
    /Network is unreachable/i,
    /Name or service not known/i,
    /Recv failure/i,
    /gnutls_handshake/i,
    /schannel/i,
    /HTTP\/2 stream/i,
  ].some((pattern) => pattern.test(detail))
}

export function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  const out = result.stdout.trim()
  return out || null
}

export function isAlphaTag(tag) {
  return typeof tag === 'string' && /^\d+\.\d+\.\d+-alpha\.\d+$/.test(tag)
}

/** @returns {{ base: string, n: number } | null} */
export function parseAlphaTag(tag) {
  const match = /^(\d+\.\d+\.\d+)-alpha\.(\d+)$/.exec(tag ?? '')
  if (!match) return null
  return { base: match[1], n: Number.parseInt(match[2], 10) }
}

export function formatAlphaTag(base, n) {
  return `${base}-alpha.${n}`
}

export function listAlphaTagsDescending() {
  const listed = runGit(['tag', '-l', ALPHA_TAG_GLOB, '--sort=-v:refname'])
  if (!listed) return []
  return listed.split('\n').map((line) => line.trim()).filter(isAlphaTag)
}

export function getHeadCommit() {
  return runGit(['rev-parse', 'HEAD'])
}

export function getTagCommit(tag) {
  return runGit(['rev-parse', `${tag}^{commit}`])
}

/**
 * 把远端的 tag 拉到本地，让自增基于全局最大值。
 * 只 fetch tag（显式 refspec，不带 + 不强制覆盖、不动分支 ref）。
 */
export function fetchRemoteAlphaTags(remote = DEFAULT_REMOTE, options = {}) {
  const {
    maxAttempts = defaultFetchMaxAttempts(),
    retryDelayMs = defaultFetchRetryDelayMs(),
    log = () => {},
  } = options
  const attempts = Math.max(1, maxAttempts)
  const delayMs = Math.max(0, retryDelayMs)
  let lastFailure = { ok: false, stderr: 'unknown error', attempts: 0 }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(
      'git',
      ['fetch', remote, '--quiet', 'refs/tags/*:refs/tags/*'],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (result.status === 0) return { ok: true, attempts: attempt }

    const stderr = (result.stderr || result.stdout || '').trim()
    lastFailure = { ok: false, stderr, attempts: attempt }

    if (attempt >= attempts || !isRetryableGitFetchError(stderr)) {
      return lastFailure
    }

    log(
      `[ensure-build-tag] 拉取 ${remote} alpha tag 失败，${formatRetryDelay(delayMs)}重试`
      + `（第 ${attempt}/${attempts} 次）：${stderr || 'unknown error'}`,
    )
    sleepSync(delayMs)
  }

  return lastFailure
}

/** 把本地 tag 推到远端。tag 已在远端同 commit → 视为成功；已在远端他 commit → 冲突。 */
export function pushTag(tag, remote = DEFAULT_REMOTE) {
  const result = spawnSync(
    'git',
    ['push', remote, `refs/tags/${tag}`],
    { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stderr = (result.stderr || result.stdout || '').trim()
  if (result.status === 0) return { ok: true, stderr }
  // 远端已存在该 tag（被别的打包机抢先占用）→ 视为可重试的冲突
  const collided = /already exists|\[rejected\].*tag|cannot lock ref|tag .* exists/i.test(stderr)
  return { ok: false, collided, stderr }
}

export function deleteLocalTag(tag) {
  runGit(['tag', '-d', tag])
}

export function getAlphaTagsOnHead() {
  const listed = runGit(['tag', '--points-at', 'HEAD', '-l', ALPHA_TAG_GLOB])
  if (!listed) return []
  return listed.split('\n').map((line) => line.trim()).filter(isAlphaTag)
}

export function pickHighestAlphaTag(tags) {
  if (!tags.length) return null
  const sorted = [...tags].sort((a, b) => {
    const pa = parseAlphaTag(a)
    const pb = parseAlphaTag(b)
    if (!pa || !pb) return 0
    if (pa.base !== pb.base) return pa.base.localeCompare(pb.base, undefined, { numeric: true })
    return pa.n - pb.n
  })
  return sorted[sorted.length - 1] ?? null
}

export function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'))
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error('apps/tabtin-electron/package.json 缺少 version')
  }
  return pkg.version.trim()
}

/**
 * 只读：当前应展示的 build tag（dev UI 用）。
 * @returns {string | null}
 */
export function resolveBuildTag() {
  const onHead = pickHighestAlphaTag(getAlphaTagsOnHead())
  if (onHead) return onHead

  const nearest = runGit(['describe', '--tags', '--abbrev=0', '--match', ALPHA_TAG_GLOB, 'HEAD'])
  if (isAlphaTag(nearest)) return nearest

  return listAlphaTagsDescending()[0] ?? null
}

export function hasDirtyWorkingTree() {
  const status = runGit(['status', '--porcelain'])
  return Boolean(status)
}

/**
 * 决定本次构建该用哪个 alpha tag（不创建、不推送）。
 * 基于当前本地可见的 alpha tag 视图（调用方负责先 fetch）。
 * @param {string} head HEAD commit hash
 * @returns {{ reuse: string, action: string, previous?: string }
 *   | { create: string, previous: string | null }}
 */
export function planNextTag(head) {
  const onHead = pickHighestAlphaTag(getAlphaTagsOnHead())
  if (onHead) {
    return { reuse: onHead, action: 'reused-on-head' }
  }

  const latest = listAlphaTagsDescending()[0] ?? null
  if (latest) {
    const parsed = parseAlphaTag(latest)
    if (!parsed) {
      throw new Error(`[ensure-build-tag] 最新 tag 格式非法: ${latest}`)
    }
    if (getTagCommit(latest) === head) {
      return { reuse: latest, action: 'reused-same-commit', previous: latest }
    }
    return { create: formatAlphaTag(parsed.base, parsed.n + 1), previous: latest }
  }
  return { create: formatAlphaTag(readPackageVersion(), 1), previous: null }
}

/**
 * 构建前 ensure：同 commit 复用 tag，新 commit 递增 alpha.N。
 *
 * syncRemote=true 时把 origin 当作全局唯一计数器：取号前 fetch、建号后 push；
 * 若 push 时该号已被别的打包机抢占，删本地号、refetch、自动 +1 重试。
 *
 * @param {{
 *   dryRun?: boolean,
 *   allowDirty?: boolean,
 *   syncRemote?: boolean,
 *   remote?: string,
 *   maxRetries?: number,
 *   log?: (msg: string) => void,
 * }} [options]
 */
export function ensureBuildTag(options = {}) {
  const {
    dryRun = false,
    allowDirty = false,
    syncRemote = false,
    remote = DEFAULT_REMOTE,
    maxRetries = 5,
    log = () => {},
  } = options

  const head = getHeadCommit()
  if (!head) {
    throw new Error('[ensure-build-tag] 不在 git 仓库内，无法打 tag')
  }
  if (!allowDirty && hasDirtyWorkingTree()) {
    throw new Error(
      '[ensure-build-tag] working tree 有未提交改动；请先提交后再构建，'
      + '或显式设置 PACK_ALLOW_DIRTY_TAG=1',
    )
  }

  if (syncRemote && !dryRun) {
    const fetched = fetchRemoteAlphaTags(remote, { log })
    if (!fetched.ok) {
      throw new Error(
        `[ensure-build-tag] 拉取 ${remote} alpha tag 失败；为避免多打包机版本号撞号，已停止构建。`
        + ` 若是明确的离线验证包，请设置 PACK_SKIP_TAG_PUSH=1 后重跑。详情：${fetched.stderr || 'unknown error'}`,
      )
    }
  }

  let attempt = 0
  while (true) {
    attempt += 1
    const plan = planNextTag(head)

    if ('reuse' in plan) {
      if (syncRemote && !dryRun) {
        const pushed = pushTag(plan.reuse, remote)
        if (!pushed.ok) {
          throw new Error(
            `[ensure-build-tag] 推送复用 tag ${plan.reuse} 到 ${remote} 失败；`
            + `为避免打包版本未同步到远端或与他机撞号，已停止构建。详情：${pushed.stderr || 'unknown error'}`,
          )
        }
      }
      return { tag: plan.reuse, action: plan.action, previous: plan.previous }
    }

    const newTag = plan.create
    const existingCommit = getTagCommit(newTag)
    if (existingCommit && existingCommit !== head) {
      throw new Error(
        `[ensure-build-tag] tag ${newTag} 已存在于 ${existingCommit.slice(0, 7)}，与 HEAD ${head.slice(0, 7)} 冲突`,
      )
    }

    if (dryRun) {
      return {
        tag: newTag,
        action: existingCommit ? 'reused-existing-name' : 'created',
        previous: plan.previous,
      }
    }

    if (!existingCommit) {
      const result = spawnSync('git', ['tag', newTag], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim()
        throw new Error(`[ensure-build-tag] git tag ${newTag} 失败: ${detail || 'unknown error'}`)
      }
    }

    if (!syncRemote) {
      return {
        tag: newTag,
        action: existingCommit ? 'reused-existing-name' : 'created',
        previous: plan.previous,
      }
    }

    const pushed = pushTag(newTag, remote)
    if (pushed.ok) {
      return {
        tag: newTag,
        action: existingCommit ? 'reused-existing-name' : 'created',
        previous: plan.previous,
      }
    }

    // push 失败：撞号（被他机抢先）且是我们刚建的本地号 → 删号 refetch 重试
    if (pushed.collided && !existingCommit && attempt < maxRetries) {
      log(`[ensure-build-tag] ${newTag} 已被 ${remote} 占用，删本地号后重新取号（第 ${attempt}/${maxRetries} 次）…`)
      deleteLocalTag(newTag)
      const refetch = fetchRemoteAlphaTags(remote, { log })
      if (!refetch.ok) {
        throw new Error(
          `[ensure-build-tag] ${newTag} 与 ${remote} 撞号后 refetch 失败；`
          + `为避免继续基于过期 tag 视图取号，已停止构建。详情：${refetch.stderr || 'unknown error'}`,
        )
      }
      continue
    }

    if (!existingCommit) {
      deleteLocalTag(newTag)
    }
    throw new Error(
      `[ensure-build-tag] 推送 tag ${newTag} 到 ${remote} 失败：${pushed.stderr || 'unknown error'}`,
    )
  }
}

function isEnsureCli() {
  try {
    if (!process.argv[1]) return false
    return pathToFileURL(resolve(process.argv[1])).href
      === pathToFileURL(resolve(__dirname, 'ensure-build-tag.mjs')).href
  } catch {
    return false
  }
}

if (isEnsureCli()) {
  if (process.env.PACK_SKIP_TAG === '1') {
    const fallback = resolveBuildTag()
    if (fallback) {
      process.stdout.write(`${fallback}\n`)
      process.exit(0)
    }
    process.stderr.write('[ensure-build-tag] PACK_SKIP_TAG=1 且无法解析现有 tag\n')
    process.exit(1)
  }

  try {
    const result = ensureBuildTag({
      allowDirty: process.env.PACK_ALLOW_DIRTY_TAG === '1',
      // 默认把 origin 当全局唯一计数器（取号前 fetch、建号后 push）；
      // 离线 / 不想推时设 PACK_SKIP_TAG_PUSH=1 退回本地取号。
      syncRemote: process.env.PACK_SKIP_TAG_PUSH !== '1',
      log: (msg) => process.stderr.write(`${msg}\n`),
    })
    const actionLabel = {
      'reused-on-head': 'HEAD 已有 tag，复用',
      'reused-same-commit': 'commit 未变，复用',
      created: '新 commit，已打 tag',
      'reused-existing-name': 'tag 名已存在，复用',
    }[result.action] ?? result.action

    process.stderr.write(
      `[ensure-build-tag] ${actionLabel}: ${result.tag}`
      + (result.previous ? `（前序 ${result.previous}）` : '')
      + '\n',
    )
    process.stdout.write(`${result.tag}\n`)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
