#!/usr/bin/env node
/**
 * 复现 / 回归：打包 feature flag 是否被 shell 继承的根 .env 锁死。
 *
 * 用法：
 *   node scripts/simulate-build-feature-flag-env.mjs
 *
 * 对应 electron.vite.config.ts 里 explicitBuildProcessEnvWinsKeys 的语义：
 * process.env 只压过根 .env；profile 文件显式键胜出。
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const rootEnvPath = resolve(appDir, '../../.env')

const FLAG_KEY = 'VITE_ENABLE_PROJECTS_UI'
const WINS_KEYS = new Set([
  'VITE_ENABLE_DEBUG_PANELS',
  FLAG_KEY,
])

function parseEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** 模拟 config 加载环（与修后语义对齐） */
function resolveFlag({ shellValue, rootValue, profileValue }) {
  const initial = shellValue === undefined ? {} : { [FLAG_KEY]: shellValue }
  let current = { ...initial }

  const applyFile = (candidatePath, fileVars) => {
    for (const [key, fileValue] of Object.entries(fileVars)) {
      if (!WINS_KEYS.has(key)) {
        current[key] = fileValue
        continue
      }
      const processOverride =
        candidatePath === rootEnvPath ? initial[key] : undefined
      current[key] = processOverride !== undefined ? processOverride : fileValue
    }
  }

  if (rootValue !== undefined) {
    applyFile(rootEnvPath, { [FLAG_KEY]: rootValue })
  }
  if (profileValue !== undefined) {
    applyFile('/profile.env', { [FLAG_KEY]: profileValue })
  }
  return current[FLAG_KEY]
}

const cases = [
  {
    name: '干净 shell + profile true',
    shellValue: undefined,
    rootValue: 'false',
    profileValue: 'true',
    expect: 'true',
  },
  {
    name: 'shell 继承根 .env false + profile true（修前会锁死 false）',
    shellValue: 'false',
    rootValue: 'false',
    profileValue: 'true',
    expect: 'true',
  },
  {
    name: 'CI 注入 true，profile 未写该键',
    shellValue: 'true',
    rootValue: 'false',
    profileValue: undefined,
    expect: 'true',
  },
  {
    name: 'profile 显式 false 不被 shell true 盖掉',
    shellValue: 'true',
    rootValue: 'false',
    profileValue: 'false',
    expect: 'false',
  },
]

let failed = 0
for (const c of cases) {
  const got = resolveFlag(c)
  const ok = got === c.expect
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}: got=${got} expect=${c.expect}`)
}

// 用仓库真实文件再跑一轮（production / preprod）
const rootReal = parseEnvFile(rootEnvPath)[FLAG_KEY]
for (const profile of ['production', 'preprod']) {
  const profilePath = resolve(appDir, `.env.${profile}`)
  const profileReal = parseEnvFile(profilePath)[FLAG_KEY]
  if (profileReal === undefined) {
    console.log(`SKIP  real ${profile}: profile 未声明 ${FLAG_KEY}`)
    continue
  }
  const polluted = resolveFlag({
    shellValue: rootReal ?? 'false',
    rootValue: rootReal ?? 'false',
    profileValue: profileReal,
  })
  const ok = polluted === profileReal
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  real ${profile} (shell=${rootReal} profile=${profileReal}): got=${polluted}`,
  )
}

process.exit(failed ? 1 : 0)
