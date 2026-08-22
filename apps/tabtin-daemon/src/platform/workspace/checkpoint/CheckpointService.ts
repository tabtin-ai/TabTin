/**
 * CheckpointService — Daemon 平台适配层
 *
 * 核心逻辑由 @tabtin/checkpoint-core 提供，本文件仅负责：
 * - 注入 Daemon 的 Logger 实例作为 CheckpointLogger
 * - 将 ~/.tabtin/checkpoints 作为 checkpointsRoot
 * - 提供单例缓存（getCheckpointService / destroyCheckpointService / destroyAllCheckpointServices）
 */

import {
  CheckpointService,
  createServiceCacheManager,
  type CheckpointServiceCache,
} from '@tabtin/checkpoint-core'
import type { Logger } from '../../observability/logging/logger.js'

export { CheckpointService } from '@tabtin/checkpoint-core'
export type { CheckpointDiffEntry, CheckpointLogger } from '@tabtin/checkpoint-core'

const CHECKPOINTS_ROOT = CheckpointService.defaultRoot()

let _logger: Logger | null = null
let _cache: CheckpointServiceCache | null = null

export function setCheckpointLogger(logger: Logger): void {
  _logger = logger
  _cache = createServiceCacheManager(
    (normalizedPath) => new CheckpointService(normalizedPath, CHECKPOINTS_ROOT, logger),
  )
}

export function getCheckpointService(projectPath: string): CheckpointService {
  if (!_cache || !_logger) {
    throw new Error('[Checkpoint] Logger not initialized — call setCheckpointLogger() first')
  }
  return _cache.get(projectPath)
}

export async function destroyCheckpointService(projectPath: string): Promise<void> {
  if (_cache) {
    await _cache.destroy(projectPath)
  }
}

export async function destroyAllCheckpointServices(): Promise<void> {
  if (_cache) {
    await _cache.destroyAll()
  }
  _logger = null
  _cache = null
}
