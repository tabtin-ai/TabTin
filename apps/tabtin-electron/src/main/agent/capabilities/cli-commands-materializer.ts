/**
 * CLI 命令树一次 spawn 物化（ 阶段 C；#9463 常驻）。
 *
 * 权威常驻缓存在 {@link CatalogStore}（StateRoot.catalog）；本模块只保留
 * Electron spawn Port 与 bind 入口。未 bind 时禁止静默 fallback（避免双实例）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CatalogStore,
  CLI_COMMANDS_CACHE_TTL_MS,
  type CliCommandsMaterialized,
} from '@tabtin/agent-host/state'
import { parseTabtinCommandsJson } from '@tabtin/agent-runtime/capability'
import { createLogger } from '../../logger.js'

const log = createLogger('cli-commands-materializer')
const CLI_COMMANDS_INIT_TIMEOUT_MS = 30_000

export { CLI_COMMANDS_CACHE_TTL_MS }
export type { CliCommandsMaterialized }

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: BufferEncoding; maxBuffer: number },
) => Promise<{ stdout: string }>

const defaultExecFileAsync = promisify(execFile) as unknown as ExecFileAsync
let execFileAsync: ExecFileAsync = defaultExecFileAsync

let boundCatalogResolver: (() => CatalogStore) | null = null

export function bindCatalogStore(resolver: () => CatalogStore): void {
  boundCatalogResolver = resolver
}

export function unbindCatalogStoreForTests(): void {
  boundCatalogResolver = null
}

export function resolveCatalogStore(): CatalogStore {
  if (!boundCatalogResolver) {
    throw new Error('CatalogStore not bound; call bindCatalogStore from ElectronAgentHost')
  }
  return boundCatalogResolver()
}

/**
 * 确保命令树已物化。命中常驻缓存直接返回；在飞请求合并；失败返回旧缓存或 null。
 */
export async function ensureCliCommandsMaterialized(): Promise<CliCommandsMaterialized | null> {
  return resolveCatalogStore().ensureCliCommandsMaterialized(
    execFileAsync,
    (stdout) => parseTabtinCommandsJson(stdout),
    (message) => log.warn(message),
  )
}

/**
 * Host 初始化 / Space 预热入口：允许完整命令目录在后台用较长预算完成。
 * 发送热路径只读快照，不再用短 spawn 预算即时拉取。
 */
export async function warmCliCommandsMaterialized(
  reason: string,
): Promise<CliCommandsMaterialized | null> {
  const startedAt = Date.now()
  const materialized = await resolveCatalogStore().ensureCliCommandsMaterialized(
    execFileAsync,
    (stdout) => parseTabtinCommandsJson(stdout),
    (message) => log.warn(message),
    { timeoutMs: CLI_COMMANDS_INIT_TIMEOUT_MS },
  )
  if (materialized) {
    log.info(
      `tabtin commands materialized reason=${reason} commands=${materialized.listing.commands.length} elapsed=${Date.now() - startedAt}ms`,
    )
  }
  return materialized
}

export function getCliCommandsMaterializedSnapshot(): CliCommandsMaterialized | null {
  return resolveCatalogStore().getCliCommandsMaterializedSnapshot()
}

/** 仅完整读取过 Hidden 命令的目录可用于受限模式风险判断。 */
export function completeCliRiskSchemas(
  materialized: CliCommandsMaterialized | null,
): CliCommandsMaterialized['schemas'] | null {
  return materialized?.riskSchemasComplete ? materialized.schemas : null
}

/** CLI 二进制升级等场景：丢常驻物化，下次 ensure 重新 spawn。 */
export function invalidateCliCommandsMaterialized(): void {
  resolveCatalogStore().invalidateCliCommands()
}

/** 测试钩子：清空缓存与在飞态，并恢复默认 spawn。 */
export function __resetCliCommandsMaterializerForTesting(): void {
  if (boundCatalogResolver) {
    resolveCatalogStore().resetCliForTesting()
  }
  execFileAsync = defaultExecFileAsync
}

/** 测试钩子：替换 spawn 实现。 */
export function __setCliCommandsExecForTesting(next: ExecFileAsync | null): void {
  execFileAsync = next ?? defaultExecFileAsync
}
