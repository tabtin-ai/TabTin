/**
 * doc-parser-runner — DocParser Worker 池的懒初始化入口
 *
 * 通过独立 worker pool 隔离文档解析：
 *   - 懒初始化（首次任务才 spawn worker）
 *   - 并发 2（POC 建议：避免打爆 CPU）
 *   - app quit 自动 dispose
 *   - 默认 idle=30 分钟缩容（对齐 POC §5 R13 建议；避免半小时没上传 PDF 后又付 400ms 冷启动）
 *   - 环境变量：`TABTIN_DOC_PARSER_WORKERS`（1–4 并发）/ `TABTIN_DOC_PARSER_IDLE_MS`（0=永不缩容）
 *
 * 测试环境（非 Electron）：dispose hook 自动忽略；runner 正常工作，便于单测
 * 直接调 `runDocParserTask` 而不需要 Electron 运行时。
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { WorkerTaskRunner, type WorkerTaskOptions } from './WorkerTaskRunner'

// 此 runner 在 Electron 主进程 + Daemon/单测 双环境运行；非 Electron 环境
// 没有 'electron' 模块，顶层 import 会让加载直接炸。用 createRequire 保留
// 按需获取 + try/catch 容错语义。
const requireOptional = createRequire(import.meta.url)
import type {
  DocParserTaskType,
  DocParserPayloadMap,
  DocParserResultMap,
} from './doc-parser-tasks'

// POC §2.Q2：warm pool 下 worker ≈ direct，2 个 worker 足以覆盖并发上传场景。
// 若需更高并发（批量附件），后续可通过 TABTIN_DOC_PARSER_WORKERS 覆盖。
const WORKER_COUNT = Math.max(
  1,
  Math.min(4, Number(process.env.TABTIN_DOC_PARSER_WORKERS) || 2),
)
const WORKER_DEBUG = process.env.TABTIN_WORKER_DEBUG === '1'

/**
 * Worker 空闲回收时长（毫秒）。POC §5 R13 建议 30min 或 Infinity，避免"半小时
 * 没上传 PDF 后又付 400ms 冷启动"的偶发卡顿；H1-D-MAIN v1.0 默认 30s 偏短，
 * v1.1 改为 30 分钟，平衡冷启动体感 vs 闲置内存占用（~30MB）。
 * 可通过 `TABTIN_DOC_PARSER_IDLE_MS` 覆盖。
 */
const IDLE_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.TABTIN_DOC_PARSER_IDLE_MS) || 30 * 60 * 1000,
)

let runner: WorkerTaskRunner | null = null
let disposeHookRegistered = false

function getWorkerScriptPath(): string {
  try {
    const { app } = requireOptional('electron') as typeof import('electron')
    const appPath = app?.getAppPath?.() ?? process.cwd()
    const resolved = join(appPath, 'out', 'main', 'doc-parser-worker.mjs')
    // worker_threads 无法从 asar 虚拟文件系统加载
    return resolved.replace('app.asar', 'app.asar.unpacked')
  } catch {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    return join(currentDir, 'doc-parser-worker.mjs')
  }
}

function getRunner(): WorkerTaskRunner {
  if (!runner) {
    runner = new WorkerTaskRunner({
      workerScriptPath: getWorkerScriptPath(),
      concurrency: WORKER_COUNT,
      name: 'doc-parser',
      debug: WORKER_DEBUG,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    })

    if (!disposeHookRegistered) {
      try {
        const { app } = requireOptional('electron') as typeof import('electron')
        app?.once('before-quit', () => {
          void runner?.dispose()
          runner = null
        })
        disposeHookRegistered = true
      } catch {
        // 非 Electron 环境（单测 / Daemon 复用）
      }
    }
  }
  return runner
}

export function runDocParserTask<T extends DocParserTaskType>(
  taskType: T,
  payload: DocParserPayloadMap[T],
  options?: WorkerTaskOptions,
): Promise<DocParserResultMap[T]> {
  return getRunner().runTask<DocParserResultMap[T]>(taskType, payload, options)
}

export async function disposeDocParserRunner(): Promise<void> {
  if (runner) {
    await runner.dispose()
    runner = null
  }
}

// 仅供单测替换 runner 用，不用于生产代码
export function __setDocParserRunnerForTesting(r: WorkerTaskRunner | null): void {
  runner = r
}
