/**
 * File-history registry —— Daemon 侧的 per-thread FileHistoryService 接入。
 *
 * 进程内模块级单例（与 checkpoint 的 `getCheckpointService` / `setCheckpointLogger`
 * 同款缓存 + logger 注入模式）：
 * - DaemonAgentHost 构造时 `setFileHistoryLogger(logger)` 注入；
 * - host `createRuntimeForSession` 调 `getOrCreateFileHistory` 注入 `EngineConfig.fileHistory`；
 * - action-bridge 回退入口调 `getFileHistory` 拿已建实例做 rewind / preview；
 * - session 销毁调 `removeFileHistory`、host 停止调 `clearAllFileHistory` 防泄漏。
 *
 * host 与 action-bridge 在 daemon 里独立组装（无直接引用），故走模块级单例共享
 * （与 checkpoint 完全对称）。平台相关只在这一层；缓存逻辑下沉
 * `@tabtin/file-history-core` 的平台无关 `FileHistoryRegistry`。
 */
import { FileHistoryRegistry, type FileHistoryService, type FileHistoryLogger } from '@tabtin/file-history-core'
import { getFileHistoryRoot } from '@tabtin/shared'

/** 宽松 logger：daemon `KernelLogger`（无 debug）与 `Logger`（有 debug）都可注入。 */
type LoggerLike = {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

const consoleFallback: FileHistoryLogger = {
  info: (...a) => console.log('[FileHistory]', ...a),
  warn: (...a) => console.warn('[FileHistory]', ...a),
  error: (...a) => console.error('[FileHistory]', ...a),
  debug: () => {},
}

let _registry: FileHistoryRegistry | null = null
let _logger: FileHistoryLogger = consoleFallback

/** 注入 daemon logger（host 构造时调一次；与 setCheckpointLogger 对称）。 */
export function setFileHistoryLogger(logger: LoggerLike): void {
  _logger = {
    info: (m, ...a) => logger.info(m, ...a),
    warn: (m, ...a) => logger.warn(m, ...a),
    error: (m, ...a) => logger.error(m, ...a),
    debug: (m, ...a) => logger.debug?.(m, ...a),
  }
  _registry = null // 重建以应用新 logger（host 构造期调用，此刻缓存仍空，无损）
}

function registry(): FileHistoryRegistry {
  if (!_registry) {
    _registry = new FileHistoryRegistry({ historyRoot: getFileHistoryRoot(), logger: _logger })
  }
  return _registry
}

/** 按 threadId 取/建 per-thread 回退引擎（host 装配期注入用）。 */
export function getOrCreateFileHistory(threadId: string, workspaceRoot: string): Promise<FileHistoryService> {
  return registry().getOrCreate(threadId, workspaceRoot)
}

/** 取已建实例（仅内存缓存命中）。未跑过 query 的 thread → undefined。 */
export function getFileHistory(threadId: string): FileHistoryService | undefined {
  return registry().get(threadId)
}

/**
 * 回退入口（action-bridge rewind / preview）用：取已建实例，**内存 miss 时从磁盘 manifest
 * lazy 恢复**（Bug 1）。修"进程重启后对一个没再发过消息的历史会话点回退失败"——重启后
 * 内存空但磁盘账本仍在。磁盘也没有 → undefined（调用方据此拒绝回退，绝不静默成功）。
 */
export function getOrResumeFileHistory(threadId: string): Promise<FileHistoryService | undefined> {
  return registry().getOrResume(threadId)
}

/** session 销毁时从缓存移除（保留磁盘备份，后续可 resume）。 */
export function removeFileHistory(threadId: string): Promise<void> {
  return registry().remove(threadId)
}

/** host 停止时清空全部缓存（保留磁盘备份）。registry 未初始化则 no-op。 */
export function clearAllFileHistory(): Promise<void> {
  return _registry ? _registry.clear() : Promise.resolve()
}
