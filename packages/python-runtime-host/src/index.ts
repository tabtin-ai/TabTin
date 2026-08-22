import fs from 'node:fs/promises'
import path from 'node:path'

import {
  ensurePythonRuntime,
  osCacheDir,
  PYTHON_RUNTIME_ENV_VAR,
  RUNTIME_NAMESPACE,
  type ResolvedPythonRuntime,
} from '@tabtin/python-runtime'

/** PATH 上暴露的独占命令名（不与系统 python3 撞名 → 不 shadow 用户环境、不受 macOS path_helper 重排影响）。 */
const SHIM_NAME = 'tabtin-python'

/** 打包资源里的运行时子目录名（extraResources to: native/<此名>）。 */
const PACKAGED_SUBDIR = 'tabtin-python-runtime'
/** 仓库内种子相对路径（build-python-runtime.sh 产出，dev 用）。 */
const REPO_SEED_RELATIVE = ['packages', 'python-runtime', 'runtime']
/** 宿主可用来覆盖运行时目录的环境变量（dev/测试用，infra 配置非业务）。 */
const ENV_RUNTIME_DIR = 'TABTIN_PYTHON_RUNTIME_DIR'

interface HostLogger {
  warn(message: string, ...args: unknown[]): void
  info?(message: string, ...args: unknown[]): void
}

/**
 * 宿主传入的原始路径提示（宿主专属，仅此为止）——候选目录的推导逻辑集中在本包，
 * 宿主不再各自拼路径。
 */
export interface WirePythonRuntimeHostConfig {
  /** Electron process.resourcesPath（打包后种子在 <此>/native/tabtin-python-runtime）。 */
  resourcesPath?: string
  /** Electron app.getAppPath()（dev 下据此定位仓库内种子）。 */
  appPath?: string
  /** 额外的候选根（少用）。 */
  extraPackagedRoots?: string[]
  /** 覆盖：显式运行时目录（缺省读 TABTIN_PYTHON_RUNTIME_DIR）。 */
  explicitRoots?: string[]
  logger?: HostLogger
}

function derivePackagedRoots(config: WirePythonRuntimeHostConfig): string[] {
  const roots: string[] = []
  if (config.resourcesPath) {
    roots.push(path.join(config.resourcesPath, 'native', PACKAGED_SUBDIR))
  }
  if (config.appPath) {
    // dev：app.getAppPath() 通常是 apps/tabtin-electron，往上两级回仓库根
    roots.push(path.join(config.appPath, '..', '..', ...REPO_SEED_RELATIVE))
    roots.push(path.join(config.appPath, ...REPO_SEED_RELATIVE))
  }
  if (config.extraPackagedRoots?.length) roots.push(...config.extraPackagedRoots)
  return roots
}

/**
 * L1 宿主接线：解析/provision 自管 Python 运行时，成功则把解释器 bin 前置到
 * process.env.PATH 并设 TABTIN_PYTHON_RUNTIME，使 agent 通过 run_terminal_command
 * spawn 的子进程里 `python3` 命中内建解释器。
 *
 * - 不复用 TABTIN_PYTHON（Django install shim 专用）。
 * - 失败不抛：无种子 / 无 OSS 时返回 null，agent 回落系统 python，不阻断宿主启动。
 * - 幂等：内建已就绪（cache 命中）时重复调用只会重设相同 env。
 */
export async function wirePythonRuntimeHost(
  config: WirePythonRuntimeHostConfig = {},
): Promise<ResolvedPythonRuntime | null> {
  const logger = config.logger ?? console
  try {
    const explicitRoots =
      config.explicitRoots ?? (process.env[ENV_RUNTIME_DIR] ? [process.env[ENV_RUNTIME_DIR] as string] : [])

    const cacheDir = osCacheDir()
    const runtime = await ensurePythonRuntime({
      cacheDir,
      packagedRoots: derivePackagedRoots(config),
      explicitRoots,
      logger,
    })

    // 按用途隔离（对齐社区对 openai/codex#30440「bundled 泄漏进用户命令」的批评）：
    //   - 内置只经 TABTIN_PYTHON_RUNTIME 与独占名 tabtin-python 暴露；
    //   - 绝不 shadow python3 —— 用户项目代码继续用其自身 venv/系统 python。
    process.env[PYTHON_RUNTIME_ENV_VAR] = runtime.pythonPath
    await exposeTabtinPythonShim(cacheDir, runtime.pythonPath, logger)
    // python3 兜底：把内建 python bin 追加到 PATH 末尾（不是前置）。
    //   - 系统有 python3（path_helper 把系统目录排在前）→ 系统优先，用户项目不受影响；
    //   - 系统无 python3 → 末尾内建成为唯一 python3 → 自动兜底。
    // 零检测、抗 macOS path_helper 重排。
    appendToPath(path.dirname(runtime.pythonPath))
    logger.info?.(`[python-runtime] ready (${runtime.origin}): ${runtime.pythonPath}`)
    return runtime
  } catch (err) {
    logger.warn(`[python-runtime] provision skipped: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** 把目录追加到 PATH 末尾（去重）——仅作 fallback，不抢系统同名命令。 */
function appendToPath(dir: string): void {
  const sep = process.platform === 'win32' ? ';' : ':'
  const current = process.env.PATH || ''
  if (current.split(sep).includes(dir)) return
  process.env.PATH = current ? `${current}${sep}${dir}` : dir
}

/**
 * 在缓存 bin 目录放一个独占名 `tabtin-python`（posix symlink / win .cmd），并把该目录
 * 前置到 process.env.PATH。该目录**只含 tabtin-python**，不含 python3，因此：
 *   - 不 shadow 系统 python3（用户项目代码照常用自身环境）；
 *   - 名字唯一 → 即便 login shell 的 path_helper 重排 PATH，`tabtin-python` 仍可解析。
 */
async function exposeTabtinPythonShim(cacheDir: string, pythonPath: string, logger: HostLogger): Promise<void> {
  const shimDir = path.join(cacheDir, RUNTIME_NAMESPACE, 'bin')
  try {
    await fs.mkdir(shimDir, { recursive: true })
    if (process.platform === 'win32') {
      const shim = path.join(shimDir, `${SHIM_NAME}.cmd`)
      await fs.writeFile(shim, `@echo off\r\n"${pythonPath}" %*\r\n`)
    } else {
      const shim = path.join(shimDir, SHIM_NAME)
      const current = await fs.readlink(shim).catch(() => null)
      if (current !== pythonPath) {
        await fs.rm(shim, { force: true }).catch(() => {})
        await fs.symlink(pythonPath, shim)
      }
    }
    const sep = process.platform === 'win32' ? ';' : ':'
    if (!(process.env.PATH || '').split(sep).includes(shimDir)) {
      process.env.PATH = `${shimDir}${sep}${process.env.PATH || ''}`
    }
  } catch (err) {
    // shim 失败不致命：仍可用 $TABTIN_PYTHON_RUNTIME 显式调用
    logger.warn(`[python-runtime] tabtin-python shim 未就绪: ${err instanceof Error ? err.message : String(err)}`)
  }
}
