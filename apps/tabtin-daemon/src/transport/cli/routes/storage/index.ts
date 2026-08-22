import type { ServerResponse } from 'node:http'

import {
  DaemonStorageApplication,
  type StorageCommand,
} from '../../../../application/storage/daemon-storage.js'
import { errorResponse, okResponse, type SendJSON } from '../shared/error-handler.js'

const STORAGE_COMMANDS = new Set<StorageCommand>([
  'list',
  'size',
  'list-items',
  'clear',
  'export',
  'vacuum',
  'drain',
  'purge',
])

function parseStorageCommand(url: string): StorageCommand | null {
  const command = url.replace(/^\/storage\/?/, '')
  return STORAGE_COMMANDS.has(command as StorageCommand) ? command as StorageCommand : null
}

/** HTTP-over-socket adapter for the storage application module. */
export async function handleStorageRoute(
  url: string,
  method: string,
  body: unknown,
  res: ServerResponse,
  sendJSON: SendJSON,
  storageApplication: DaemonStorageApplication,
): Promise<void> {
  if (method !== 'POST') {
    sendJSON(res, 405, errorResponse('VALIDATION_ERROR', `Storage 路由仅接受 POST，收到 ${method}`))
    return
  }

  const command = parseStorageCommand(url)
  if (!command) {
    sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知 storage 子路由: ${url}`, {
      suggestions: ['可用子命令: list / size / list-items / clear / export / vacuum / drain / purge'],
    }))
    return
  }

  try {
    const outcome = await storageApplication.execute(command, body)
    if (outcome.payload.ok) {
      sendJSON(res, outcome.status, okResponse(outcome.payload.data))
    } else {
      sendJSON(res, outcome.status, errorResponse(
        outcome.payload.error.code,
        outcome.payload.error.message,
        outcome.payload.error.details,
      ))
    }
  } catch (error) {
    sendJSON(res, 500, errorResponse(
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
    ))
  }
}
