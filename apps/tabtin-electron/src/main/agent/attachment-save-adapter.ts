import * as path from 'node:path'

import type {
  SaveAttachmentToWorkspaceInput,
  SaveAttachmentToWorkspaceResult,
} from '@tabtin/agent-host/tools'
import { createLogger } from '../logger.js'
import { getResourceDownloadService } from '../services/ResourceDownloadService.js'

const ATTACHMENTS_DIRECTORY = 'attachments'
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const log = createLogger('attachment-save')

export async function saveAttachmentToWorkspace(
  input: SaveAttachmentToWorkspaceInput,
): Promise<SaveAttachmentToWorkspaceResult> {
  const startedAt = Date.now()
  log.info(
    `[save] start fileId=${input.fileId} expectedSize=${input.expectedSize ?? 'unknown'}`,
  )

  try {
    input.abortSignal.throwIfAborted()

    const workspaceRoot = path.resolve(input.workspaceRoot)
    const outputDir = path.join(workspaceRoot, ATTACHMENTS_DIRECTORY)
    const downloaded = await getResourceDownloadService().download({
      url: input.sourceUrl,
      filename: input.filename,
      outputDir,
      maxBytes: MAX_ATTACHMENT_BYTES,
    })

    input.abortSignal.throwIfAborted()
    const relativePath = path.relative(workspaceRoot, downloaded.filePath)
    if (
      relativePath.length === 0
      || relativePath.startsWith('..')
      || path.isAbsolute(relativePath)
    ) {
      throw new Error('Attachment download escaped the current Workspace.')
    }

    log.info(
      `[save] success fileId=${input.fileId} size=${downloaded.size} durationMs=${Date.now() - startedAt}`,
    )
    return {
      relativePath: relativePath.split(path.sep).join('/'),
      size: downloaded.size,
      mimeType: downloaded.mimeType || input.mimeType || 'application/octet-stream',
    }
  } catch (error) {
    log.error(
      `[save] failed fileId=${input.fileId} durationMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}
