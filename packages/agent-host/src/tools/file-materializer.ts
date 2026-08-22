import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { uploadFileToOSS } from '@tabtin/action-tools/utils/oss-upload';

export interface FileMaterializationRef {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url?: string;
}

export interface FileMaterializeInput {
  path: string;
  mimeType?: string;
  filename?: string;
  threadId: string;
  agentRunId?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}

export interface FileMaterializer {
  materialize(input: FileMaterializeInput): Promise<FileMaterializationRef>;
}

export interface OssFileMaterializerOptions {
  organizationId?: string;
}

const BYTES_PER_MEBIBYTE = 1024 * 1024;
const FILE_MATERIALIZATION_MAX_MEBIBYTES = 50;
export const FILE_MATERIALIZATION_MAX_BYTES =
  FILE_MATERIALIZATION_MAX_MEBIBYTES * BYTES_PER_MEBIBYTE;
const OSS_ALLOWED_READ_FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.txt',
  '.zip',
]);

export class FileMaterializationTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(
      `File exceeds the ${FILE_MATERIALIZATION_MAX_MEBIBYTES}MB `
      + `read_file materialization limit (${sizeBytes} bytes).`,
    );
    this.name = 'FileMaterializationTooLargeError';
  }
}

function stableContextId(input: FileMaterializeInput): string {
  const identity = JSON.stringify({
    threadId: input.threadId,
    agentRunId: input.agentRunId,
    toolUseId: input.toolUseId,
    filename: path.basename(input.path),
  });
  return `read-file:${createHash('sha256').update(identity).digest('hex')}`;
}

function needsSafeOssUploadName(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return !OSS_ALLOWED_READ_FILE_EXTENSIONS.has(ext);
}

async function prepareOssUploadPath(inputPath: string): Promise<{
  uploadPath: string;
  cleanupPath?: string;
}> {
  if (!needsSafeOssUploadName(inputPath)) {
    return { uploadPath: inputPath };
  }

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabtin-read-file-upload-'));
  const basenameWithoutExt = path.basename(inputPath, path.extname(inputPath)) || 'file';
  const uploadPath = path.join(tmpDir, `${basenameWithoutExt}.txt`);
  await fsPromises.copyFile(inputPath, uploadPath);
  return { uploadPath, cleanupPath: tmpDir };
}

export function createOssFileMaterializer(
  options: OssFileMaterializerOptions = {},
): FileMaterializer {
  return {
    async materialize(input: FileMaterializeInput): Promise<FileMaterializationRef> {
      if (input.signal?.aborted) {
        throw new Error('materialization aborted before upload');
      }

      const stat = await fsPromises.stat(input.path);
      if (!stat.isFile()) {
        throw new Error('materialization target is not a regular file');
      }
      if (stat.size > FILE_MATERIALIZATION_MAX_BYTES) {
        throw new FileMaterializationTooLargeError(stat.size);
      }

      const mimeType = input.mimeType ?? 'application/octet-stream';
      const filename = input.filename ?? path.basename(input.path);
      const preparedUpload = await prepareOssUploadPath(input.path);
      let upload;
      try {
        upload = await uploadFileToOSS(preparedUpload.uploadPath, {
          folder: 'agent/read-file',
          module: 'agent',
          contextType: 'conversation_context',
          contextId: stableContextId(input),
          mimeType,
          organizationId: options.organizationId,
          isPublic: false,
          signal: input.signal,
        });
      } finally {
        if (preparedUpload.cleanupPath) {
          await fsPromises.rm(preparedUpload.cleanupPath, { recursive: true, force: true });
        }
      }

      if (!upload.fileId) {
        throw new Error(upload.error ?? 'OSS upload did not return a FileRecord id');
      }

      return {
        fileId: upload.fileId,
        filename,
        mimeType,
        sizeBytes: stat.size,
        url: upload.cdnUrl || upload.url || undefined,
      };
    },
  };
}
