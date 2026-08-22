/**
 * @tabtin/local-docparse/workers — Worker 协议 + handlers + 通用 Runner
 *
 * 拆出 `./workers` 子路径的原因：宿主侧 worker entry 脚本只需要 handlers +
 * protocol，**不应**误 import 主入口 `parseLocalAttachment.ts`，否则
 * worker bundle 会拖入 fetch / Readable / tmp 文件目录等主线程依赖。
 *
 * 宿主 worker entry 模板：
 *   ```ts
 *   import { parentPort } from 'node:worker_threads'
 *   import {
 *     handleParsePdf, handleParseDocx, handleParseXlsx,
 *     serializeWorkerError,
 *     type WorkerTaskRequestMessage, type WorkerTaskResponseMessage,
 *   } from '@tabtin/local-docparse/workers'
 *
 *   parentPort!.on('message', async (msg: WorkerTaskRequestMessage) => {
 *     if (msg.kind !== 'task') return
 *     try {
 *       const result = await dispatch(msg.taskType, msg.payload)
 *       parentPort!.postMessage({ kind: 'result', taskId: msg.taskId, ok: true, result })
 *     } catch (error) {
 *       parentPort!.postMessage({
 *         kind: 'result', taskId: msg.taskId, ok: false,
 *         error: serializeWorkerError(error),
 *       })
 *     }
 *   })
 *   ```
 */

export {
  handleParseDocx,
  handleParsePdf,
  handleParseXlsx,
} from './handlers.js'

export type {
  DocParserPayloadMap,
  DocParserResultMap,
  DocParserTaskType,
  ParseDocxPayload,
  ParseDocxResult,
  ParsePdfPayload,
  ParsePdfResult,
  ParseXlsxPayload,
  ParseXlsxResult,
} from './tasks.js'

export {
  serializeWorkerError,
} from './protocol.js'

export type {
  SerializedWorkerError,
  WorkerTaskRequestMessage,
  WorkerTaskResponseMessage,
} from './protocol.js'

export {
  WorkerTaskAbortedError,
  WorkerTaskError,
  WorkerTaskRunner,
} from './runner.js'

export type {
  QueueStrategy,
  WorkerTaskOptions,
  WorkerTaskRunnerOptions,
} from './runner.js'
