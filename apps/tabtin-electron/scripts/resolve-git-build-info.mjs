#!/usr/bin/env node
/**
 * 解析构建期 git 元数据，供诊断包 meta.json 写入。
 *
 * 优先级：
 *   1. 显式 env（CI / 打包机 override）：VITE_GIT_COMMIT / VITE_GIT_BRANCH
 *   2. 当前工作树 `git rev-parse`
 *   3. 空字符串（非 git 目录 / 沙箱无 git 时不阻断构建）
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {string[]} args
 * @returns {string}
 */
function defaultRunGit(args) {
  try {
    const result = spawnSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status !== 0) return ''
    return (result.stdout || '').trim()
  } catch {
    return ''
  }
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv
 *   runGit?: (args: string[]) => string
 * }} [opts]
 * @returns {{ commit: string, branch: string }}
 */
export function resolveGitBuildInfo(opts = {}) {
  const env = opts.env ?? process.env
  const runGit = opts.runGit ?? defaultRunGit

  const commitFromEnv = typeof env.VITE_GIT_COMMIT === 'string' ? env.VITE_GIT_COMMIT.trim() : ''
  const branchFromEnv = typeof env.VITE_GIT_BRANCH === 'string' ? env.VITE_GIT_BRANCH.trim() : ''

  const commit = commitFromEnv || runGit(['rev-parse', '--short=12', 'HEAD']) || ''
  let branch = branchFromEnv || runGit(['rev-parse', '--abbrev-ref', 'HEAD']) || ''
  // detached HEAD 时 abbrev-ref 返回 "HEAD"，对定位无帮助，置空
  if (branch === 'HEAD') branch = ''

  return { commit, branch }
}

/**
 * 把解析结果写入 process.env（仅在对应键尚未设置时），供 vite loadEnv 暴露给客户端。
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv
 *   runGit?: (args: string[]) => string
 *   log?: (msg: string) => void
 * }} [opts]
 * @returns {{ commit: string, branch: string }}
 */
export function injectGitBuildInfoEnv(opts = {}) {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((msg) => console.log(msg))
  const { commit, branch } = resolveGitBuildInfo({ env, runGit: opts.runGit })

  if (commit && !env.VITE_GIT_COMMIT) {
    env.VITE_GIT_COMMIT = commit
  }
  if (branch && !env.VITE_GIT_BRANCH) {
    env.VITE_GIT_BRANCH = branch
  }

  const finalCommit = (env.VITE_GIT_COMMIT || '').trim()
  const finalBranch = (env.VITE_GIT_BRANCH || '').trim()
  if (finalCommit || finalBranch) {
    log(
      `[run-electron-vite] 注入 VITE_GIT_COMMIT="${finalCommit}" VITE_GIT_BRANCH="${finalBranch}"`,
    )
  }

  return { commit: finalCommit, branch: finalBranch }
}

const isCli = (() => {
  try {
    if (!process.argv[1]) return false
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
})()

if (isCli) {
  const info = resolveGitBuildInfo()
  process.stdout.write(`${JSON.stringify(info)}\n`)
}
