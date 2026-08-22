/**
 * doc-parser-worker — Worker Thread 协议入口（Daemon 侧）
 *
 * 职责拆分（与 Electron 完全对称）：
 *   - 本文件：只负责 worker_threads 协议分发（message in → task handler → message out）
 *   - `@tabtin/local-docparse/workers`：承载实际的 PDF/docx/xlsx 解析纯函数
 *
 * 与 Electron `apps/tabtin-electron/src/main/workers/doc-parser-worker.ts` 唯一
 * 差异是构建工具（tsup vs electron-vite）和 worker 脚本的最终输出路径——业务
 * 逻辑零差异。改动 handlers 行为只需改 packages 一处。
 */

import { parentPort } from 'node:worker_threads'
import {
  handleParseDocx,
  handleParsePdf,
  handleParseXlsx,
  serializeWorkerError,
  type ParseDocxPayload,
  type ParsePdfPayload,
  type ParseXlsxPayload,
  type WorkerTaskRequestMessage,
  type WorkerTaskResponseMessage,
} from '@tabtin/local-docparse/workers'

async function handleTask(request: WorkerTaskRequestMessage): Promise<unknown> {
  switch (request.taskType) {
    case 'parse-pdf':
      return handleParsePdf(request.payload as ParsePdfPayload)
    case 'parse-docx':
      return handleParseDocx(request.payload as ParseDocxPayload)
    case 'parse-xlsx':
      return handleParseXlsx(request.payload as ParseXlsxPayload)
    default:
      throw new Error(`Unknown doc-parser task: ${request.taskType}`)
  }
}

parentPort!.on('message', async (message: WorkerTaskRequestMessage) => {
  if (message.kind !== 'task') return
  try {
    const result = await handleTask(message)
    const response: WorkerTaskResponseMessage = {
      kind: 'result',
      taskId: message.taskId,
      ok: true,
      result,
    }
    parentPort!.postMessage(response)
  } catch (error) {
    const response: WorkerTaskResponseMessage = {
      kind: 'result',
      taskId: message.taskId,
      ok: false,
      error: serializeWorkerError(error),
    }
    parentPort!.postMessage(response)
  }
})
