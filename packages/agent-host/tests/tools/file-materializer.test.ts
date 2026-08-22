import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_MATERIALIZATION_MAX_BYTES,
  FileMaterializationTooLargeError,
  createOssFileMaterializer,
} from '../../src/tools/file-materializer.js';
import { uploadFileToOSS } from '@tabtin/action-tools/utils/oss-upload';

vi.mock('@tabtin/action-tools/utils/oss-upload', () => ({
  uploadFileToOSS: vi.fn(),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-host-materializer-'));
  vi.mocked(uploadFileToOSS).mockReset();
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe('createOssFileMaterializer', () => {
  it('uploads the file and returns FileRecord metadata', async () => {
    vi.mocked(uploadFileToOSS).mockResolvedValueOnce({
      url: 'https://oss.example/readme.pdf',
      fileId: 'file_123',
      cdnUrl: 'https://cdn.example/readme.pdf',
    });
    const filePath = path.join(tmpDir, 'readme.pdf');
    const bytes = Buffer.from('pdf-bytes');
    await fsPromises.writeFile(filePath, bytes);

    const materializer = createOssFileMaterializer({ organizationId: 'org-1' });
    const ref = await materializer.materialize({
      path: filePath,
      filename: 'readme.pdf',
      mimeType: 'application/pdf',
      threadId: 'thread-1',
      toolUseId: 'tool-1',
    });

    expect(ref).toEqual({
      fileId: 'file_123',
      filename: 'readme.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      url: 'https://cdn.example/readme.pdf',
    });
    expect(uploadFileToOSS).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({
        folder: 'agent/read-file',
        module: 'agent',
        contextType: 'conversation_context',
        contextId: expect.stringMatching(/^read-file:[0-9a-f]{64}$/),
        mimeType: 'application/pdf',
        organizationId: 'org-1',
        isPublic: false,
      }),
    );
  });

  it('passes cancellation through the OSS upload', async () => {
    vi.mocked(uploadFileToOSS).mockResolvedValueOnce({
      url: 'https://oss.example/readme.pdf',
      fileId: 'file_123',
    });
    const filePath = path.join(tmpDir, 'readme.pdf');
    await fsPromises.writeFile(filePath, 'pdf-bytes');
    const controller = new AbortController();

    await createOssFileMaterializer().materialize({
      path: filePath,
      mimeType: 'application/pdf',
      threadId: 'thread-1',
      signal: controller.signal,
    });

    expect(uploadFileToOSS).toHaveBeenCalledWith(
      filePath,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('uploads unsupported extensions with an OSS-allowed filename while preserving display name', async () => {
    vi.mocked(uploadFileToOSS).mockResolvedValueOnce({
      url: 'https://oss.example/opaque.txt',
      fileId: 'file_binary',
    });
    const filePath = path.join(tmpDir, 'opaque.dat');
    const bytes = Buffer.from([0, 1, 2, 3]);
    await fsPromises.writeFile(filePath, bytes);

    const materializer = createOssFileMaterializer();
    const ref = await materializer.materialize({
      path: filePath,
      filename: 'opaque.dat',
      mimeType: 'application/octet-stream',
      threadId: 'thread-1',
    });

    expect(ref).toMatchObject({
      fileId: 'file_binary',
      filename: 'opaque.dat',
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.length,
      url: 'https://oss.example/opaque.txt',
    });

    const [[uploadPath, uploadOptions]] = vi.mocked(uploadFileToOSS).mock.calls;
    expect(uploadPath).not.toBe(filePath);
    expect(uploadPath.endsWith('.txt')).toBe(true);
    await expect(fsPromises.stat(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(uploadOptions).toEqual(expect.objectContaining({
      folder: 'agent/read-file',
      mimeType: 'application/octet-stream',
      isPublic: false,
    }));
  });

  it('rejects oversized files before upload', async () => {
    const filePath = path.join(tmpDir, 'large.pdf');
    await fsPromises.writeFile(filePath, '');
    await fsPromises.truncate(filePath, FILE_MATERIALIZATION_MAX_BYTES + 1);

    await expect(createOssFileMaterializer().materialize({
      path: filePath,
      mimeType: 'application/pdf',
      threadId: 'thread-1',
    })).rejects.toBeInstanceOf(FileMaterializationTooLargeError);
    expect(uploadFileToOSS).not.toHaveBeenCalled();
  });

  it('fails when OSS upload does not return a FileRecord id', async () => {
    vi.mocked(uploadFileToOSS).mockResolvedValueOnce({
      url: null,
      error: 'missing file id',
      errorCode: 'unknown',
    });
    const filePath = path.join(tmpDir, 'image.png');
    await fsPromises.writeFile(filePath, Buffer.from([1, 2, 3]));

    const materializer = createOssFileMaterializer();

    await expect(materializer.materialize({
      path: filePath,
      mimeType: 'image/png',
      threadId: 'thread-1',
    })).rejects.toThrow('missing file id');
  });

  it('uses a deterministic context id within the backend 128-character limit', async () => {
    vi.mocked(uploadFileToOSS).mockResolvedValue({
      url: 'https://oss.example/file.pdf',
      fileId: 'file_123',
    });
    const filePath = path.join(tmpDir, `${'long-name-'.repeat(12)}.pdf`);
    await fsPromises.writeFile(filePath, Buffer.from('pdf-bytes'));
    const materializer = createOssFileMaterializer();
    const baseInput = {
      path: filePath,
      mimeType: 'application/pdf',
      threadId: `chat-session-${'a'.repeat(64)}`,
      agentRunId: `agent-run-${'b'.repeat(64)}`,
      toolUseId: `tool-use-${'c'.repeat(64)}`,
    };

    await materializer.materialize(baseInput);
    await materializer.materialize(baseInput);
    await materializer.materialize({ ...baseInput, toolUseId: `${baseInput.toolUseId}-other` });

    const contextIds = vi.mocked(uploadFileToOSS).mock.calls.map(
      ([, options]) => options?.contextId,
    );
    expect(contextIds[0]).toHaveLength(74);
    expect(contextIds[0]).toBe(contextIds[1]);
    expect(contextIds[2]).not.toBe(contextIds[0]);
  });
});
