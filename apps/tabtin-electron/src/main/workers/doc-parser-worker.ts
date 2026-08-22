/**
 * doc-parser-worker — Worker Thread 协议入口
 *
 * 职责拆分：
 *   - 本文件：只负责 worker_threads 协议分发（message in → task handler → message out）
 *   - `doc-parser-handlers.ts`：承载实际的 PDF/docx/xlsx 解析逻辑（便于单测直接调用）
 *
 * 设计决策（来自 POC §2.Q2 warm worker pool）：
 *   1. 懒加载模块（pdfjs / mammoth / xlsx）由 handlers 内部处理
 *   2. 首次任务冷启动 ~400ms，后续 warm 复用
 *   3. 错误透传：worker 捕获原生异常 name/message，主线程 localDocParse 做 classification
 */

import { parentPort } from 'node:worker_threads'
import type {
  WorkerTaskRequestMessage,
  WorkerTaskResponseMessage,
} from './worker-task-protocol'
import { serializeWorkerError } from './worker-task-protocol'
import {
  handleParseDocx,
  handleParsePdf,
  handleParseXlsx,
} from './doc-parser-handlers'
import type {
  ParseDocxPayload,
  ParsePdfPayload,
  ParseXlsxPayload,
} from './doc-parser-tasks'

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
