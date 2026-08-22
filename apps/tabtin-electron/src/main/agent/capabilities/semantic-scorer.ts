/**
 * 语义打分器单例（ 双路召回）——Electron main 宿主装配。
 *
 * 进程级一个 `LocalEmbeddingService`，包装成 `SemanticScorer` 后注入：
 * - `initSkillsModule`（skill 动态段）
 * - `McpCap` / `CliCap` 构造参数（MCP / CLI 动态段）
 *
 * 模型目录（ 生产零下载）：
 * - 打包环境：安装包内置的 `Resources/models`（electron-builder extraResources）；
 * - dev 环境：`~/.tabtin/models`（跑一次 `node scripts/electron/runtime/fetch-embedding-model.mjs` 置入，
 *   与 Daemon 共享同一份磁盘资产）。
 *
 * `warmup()` 在首次获取时后台触发（纯本地文件加载，零网络），不阻塞启动与
 * 首轮对话；就绪前 scorer 返回 null，融合层自动走词法单路。
 */

import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import type { WarmableSemanticScorer } from '@tabtin/search'
import { LocalEmbeddingService, createSemanticScorer } from '@tabtin/local-embedding'
import { createLogger } from '../../logger.js'
import { hasLocalSemanticModel } from './semantic-model-files.js'

const log = createLogger('semantic-scorer')

let scorer: WarmableSemanticScorer | null = null

function createDisabledSemanticScorer(): WarmableSemanticScorer {
  return {
    async score(): Promise<null> {
      return null
    },
    warm(): void {
      // no-op: packaged macOS arm64 currently avoids onnxruntime in Electron main.
    },
  }
}

/**
 * 方案 B（进程隔离）：dev 环境把 onnxruntime 推理关进独立子进程，ORT 崩溃只死
 * 子进程、主进程降级词法，不再 SIGABRT 整个 app。子进程 entry 由 electron.vite
 * 作为独立 input 打包到 `out/main/onnx-embed-child.mjs`（路径解析对齐
 * doc-parser-runner；asar → asar.unpacked）。
 *
 * 仅在 dev（`!app.isPackaged`）启用：打包版的隔离需额外的 electron-builder
 * unpack + 真机验证，属后续工作；打包版维持既有行为（x64 同进程、arm64 禁用）。
 * 解析不到 entry 文件时返回 undefined → service 回落同进程后端（不改变现状）。
 */
function resolveOnnxChildEntryPath(): string | undefined {
  if (app.isPackaged) return undefined
  const p = path.join(app.getAppPath(), 'out', 'main', 'onnx-embed-child.mjs')
  return existsSync(p) ? p : undefined
}

export function getSemanticScorer(): WarmableSemanticScorer {
  if (scorer) return scorer
  const modelsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(os.homedir(), '.tabtin', 'models')
  if (app.isPackaged && process.platform === 'darwin' && process.arch === 'arm64') {
    log.warn('语义模型在 macOS arm64 打包版中已禁用，本轮使用词法召回兜底')
    scorer = createDisabledSemanticScorer()
    return scorer
  }
  if (!hasLocalSemanticModel(modelsDir)) {
    log.info(
      '本地语义模型未安装，本次会话使用词法召回；需要语义召回时运行 node scripts/electron/runtime/fetch-embedding-model.mjs 后重启客户端'
    )
    scorer = createDisabledSemanticScorer()
    return scorer
  }
  const onnxChildEntryPath = resolveOnnxChildEntryPath()
  if (onnxChildEntryPath) {
    log.info(`语义模型走进程隔离子进程：${onnxChildEntryPath}`)
  } else {
    log.info('语义模型走同进程后端（未启用进程隔离）')
  }
  const service = new LocalEmbeddingService({
    modelsDir,
    ...(onnxChildEntryPath ? { onnxChildEntryPath } : {}),
    log: (msg) => log.info(msg),
  })
  service.warmup().catch((err: unknown) => {
    // 失败已在 service 内记日志；下轮对话仍走词法单路，不影响主链路。
    log.warn(`语义模型预热失败（本次会话将走词法单路）：${err instanceof Error ? err.message : String(err)}`)
  })
  scorer = createSemanticScorer(service)
  return scorer
}
