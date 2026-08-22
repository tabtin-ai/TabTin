/**
 * CLI Profile Bootstrap
 *
 * 首次启动 TabTin 后，Go CLI 在 `~/.tabtin/config.json` 里看不到 profile.token
 * 会触发 fail-fast 闸门（`packages/tabtin-cli-go/internal/cmdutil/pipeline.go`
 * 中 `RequiresAuth: true` 命令的预检），所有 `tabtin doc/table/space/...`
 * 等命令立刻报 UNAUTHORIZED——即使用户已经在 Electron 应用里登录了。
 *
 * 真正的认证链路其实是工作的：Go CLI 经 SocketTransport 把请求转给
 * Electron CLI Server，Server 内部用 TokenManager.getAccessToken() 持有的
 * 真 JWT 去访问 Django。**fail-fast 闸门不知道这条路径存在**，它只看
 * config.json 里 profile.token 是否非空。
 *
 * 本模块只解决"非空"这件事——在 Electron CLI Server 启动末尾，如果
 * `~/.tabtin/config.json` 不存在就写一个 placeholder profile，token 字段
 * 是字面字符串 `"managed-by-electron"`，永远不会被任何后端验证，纯粹用来
 * 让 fail-fast 闸门放行。
 *
 * 设计取舍：
 *   - **绝不覆盖已存在的 config.json**：用户可能手动跑过 `tabtin auth login`
 *     存了真 token、或在外部 CI 配过其它 profile，这里只做首次初始化
 *   - **token 字段是字面占位符，不是真 JWT**：真 JWT 留在 TokenManager
 *     keychain 里、不下盘。符合 SD-039 §4.5 "不让 token 文件落盘"的安全意图
 *     （详见 support/strategy/2026-03-24-sd039-sock-assessment.md）
 *   - **不监听 TokenManager 任何事件**：placeholder 不需要随真 token 刷新
 *     而更新——它从头到尾都不是真 token。这避免了跨进程同步问题
 *   - **不在登出时清理**：placeholder 留着无害（本来就不是凭据），下次登录
 *     依然能用同一个 placeholder 通过 fail-fast 闸门
 *
 * 长期演进：SD-039 Phase 2（per-session scoped token）落地后，Go CLI 端的
 * fail-fast 闸门设计需要重新审视——届时可以考虑彻底移除这个 placeholder。
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { API_BASE_URL } from '../config/api'
import { TokenManager } from '../auth'
import { createLogger } from '../logger'

const log = createLogger('CLIProfileBootstrap')

const CLI_PLACEHOLDER_TOKEN = 'managed-by-electron'
const CLI_CONFIG_FILE = 'config.json'

interface CLIProfileConfig {
  version: number
  currentProfile: string
  profiles: Record<string, {
    baseURL?: string
    token?: string
    label?: string
    defaultSpace?: string
    defaultOrganization?: string
  }>
  defaults: Record<string, unknown>
}

function buildPlaceholderConfig(): CLIProfileConfig {
  return {
    version: 2,
    currentProfile: 'default',
    profiles: {
      default: {
        baseURL: API_BASE_URL,
        token: CLI_PLACEHOLDER_TOKEN,
        label: 'TabTin App',
      },
    },
    defaults: {},
  }
}

/**
 * 原子写入：先写 .tmp，chmod 0o600，再 rename 覆盖。
 * 防止 Go CLI 读到半成品 JSON。
 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 })
    if (process.platform !== 'win32') {
      chmodSync(tmpPath, 0o600)
    }
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* tmp 可能根本没创建出来，忽略 */ }
    throw err
  }
}

/**
 * 启动期幂等初始化 CLI profile。
 *
 * 返回值：
 *   - 'created'：config.json 不存在，本次写入了 placeholder
 *   - 'exists'：config.json 已存在，未动
 *   - 'skipped_no_login'：用户未登录 Electron，不写（避免给未登录用户造假凭据）
 *   - 'failed'：写入失败（已 log，不抛错，不阻塞 CLI Server 启动）
 *
 * 失败不会影响 CLI Server 启动——最坏情况下用户体验降级到修复前的现状
 * （Agent 跑 RequiresAuth 命令时仍会被 fail-fast 拦下）。
 */
export async function ensureCliProfileBootstrap(): Promise<
  'created' | 'exists' | 'skipped_no_login' | 'failed'
> {
  try {
    const configDir = getHomeTabtinPath()
    const configPath = join(configDir, CLI_CONFIG_FILE)

    if (existsSync(configPath)) {
      log.info('config.json 已存在，跳过初始化')
      return 'exists'
    }

    const accessToken = await TokenManager.getAccessToken()
    if (!accessToken) {
      log.info('用户未登录 Electron，跳过 placeholder profile 初始化')
      return 'skipped_no_login'
    }

    try { mkdirSync(configDir, { recursive: true, mode: 0o700 }) } catch { /* exists or no perm */ }

    const config = buildPlaceholderConfig()
    const content = JSON.stringify(config, null, 2)
    atomicWrite(configPath, content)

    log.info(`✅ 已初始化 ${configPath}（placeholder token，baseURL=${API_BASE_URL}）`)
    return 'created'
  } catch (err) {
    log.warn('初始化失败，Agent 跑 CLI 命令时可能遇到 UNAUTHORIZED：', err)
    return 'failed'
  }
}

export const __testing__ = {
  CLI_PLACEHOLDER_TOKEN,
  CLI_CONFIG_FILE,
  buildPlaceholderConfig,
}
