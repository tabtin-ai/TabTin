/**
 * OSS 云端文件交付物解析 / 建卡单测。
 *
 * ：`oss-file-artifact` 从 agent-runtime 的 capability/core 迁到
 * @tabtin/agent-host 的 delivery 目录，本单测随源迁来；对源的 import 指向
 * host 的 `src/delivery/oss-file-artifact.js`。断言的是迁移后（字节级一致）的现有行为。
 */

import { describe, expect, it } from 'vitest';
import {
  buildOssFileArtifactBlock,
  buildOssFileArtifactBlockFromUpload,
  extractOssUploadFilename,
  isOssUploadCommand,
  parseOssUploadResult,
} from '../src/delivery/oss-file-artifact.js';

const FILE_ID = '550e8400-e29b-41d4-a716-446655440000';
const ACCESS_URL = 'https://cdn.example.com/agent/uploads/chart.png';

describe('isOssUploadCommand', () => {
  it('matches tabtin oss upload', () => {
    expect(isOssUploadCommand('tabtin oss upload /tmp/a.png')).toBe(true);
    expect(isOssUploadCommand('tabtin oss upload /tmp/a.png --format json')).toBe(true);
    expect(isOssUploadCommand('cd /tmp && tabtin oss upload ./a.png')).toBe(true);
  });

  it('matches upload after a quoted multiline variable assignment', () => {
    const command = [
      "FILE='",
      'generated report',
      "'",
      'tabtin oss upload "$FILE" --format json',
    ].join('\n');

    expect(isOssUploadCommand(command)).toBe(true);
  });

  it('rejects non-upload commands', () => {
    expect(isOssUploadCommand('tabtin oss list')).toBe(false);
    expect(isOssUploadCommand('echo tabtin oss upload')).toBe(false);
    expect(isOssUploadCommand('tabtin doc create --title x')).toBe(false);
  });
});

describe('extractOssUploadFilename', () => {
  it('reads positional path', () => {
    expect(extractOssUploadFilename('tabtin oss upload /tmp/chart.png --format json')).toBe(
      'chart.png',
    );
  });

  it('reads --file-path', () => {
    expect(
      extractOssUploadFilename('tabtin oss upload --file-path /home/u/report.pdf --format json'),
    ).toBe('report.pdf');
  });
});

describe('parseOssUploadResult', () => {
  it('parses JSON envelope', () => {
    const stdout = JSON.stringify({
      ok: true,
      data: {
        url: ACCESS_URL,
        file_id: FILE_ID,
        file_key: 'agent/uploads/x',
        cdn_url: ACCESS_URL,
      },
    });
    expect(parseOssUploadResult('tabtin oss upload /tmp/chart.png --format json', stdout)).toEqual({
      fileId: FILE_ID,
      accessUrl: ACCESS_URL,
      filename: 'chart.png',
      mimeType: 'image/png',
      fileType: 'png',
      fileSize: undefined,
    });
  });

  it('parses agent text lines', () => {
    const stdout = [
      'ok: true',
      'data:',
      `  file_id: ${FILE_ID}`,
      `  url: ${ACCESS_URL}`,
    ].join('\n');
    const parsed = parseOssUploadResult('tabtin oss upload ./deck.pptx', stdout);
    expect(parsed).toMatchObject({
      fileId: FILE_ID,
      accessUrl: ACCESS_URL,
      filename: 'deck.pptx',
      fileType: 'pptx',
    });
  });

  it('returns null for failed upload', () => {
    expect(
      parseOssUploadResult(
        'tabtin oss upload /tmp/a.png --format json',
        JSON.stringify({ ok: false, error: { message: 'boom' } }),
      ),
    ).toBeNull();
  });

  it('returns null for non-oss commands', () => {
    expect(
      parseOssUploadResult(
        'tabtin doc list --format json',
        JSON.stringify({ ok: true, data: { file_id: FILE_ID, url: ACCESS_URL } }),
      ),
    ).toBeNull();
  });
});

describe('buildOssFileArtifactBlock', () => {
  it('builds delivery payload with tabtin url and access_url', () => {
    const block = buildOssFileArtifactBlock({
      fileId: FILE_ID,
      accessUrl: ACCESS_URL,
      filename: 'chart.png',
      mimeType: 'image/png',
      fileType: 'png',
      fileSize: 100,
      autoOpen: true,
      autoOpenToken: 'tok-1',
    });
    expect(block.kind).toBe('file');
    expect(block.payload.artifact_kind).toBe('oss_file');
    expect(block.payload.file_id).toBe(FILE_ID);
    expect(block.payload.access_url).toBe(ACCESS_URL);
    expect(String(block.payload.url)).toContain(FILE_ID);
    expect(String(block.payload.url)).toContain('hint=tabfiles');
    expect(block.payload.auto_open).toBe(true);
  });
});

describe('buildOssFileArtifactBlockFromUpload', () => {
  it('returns null when stdout cannot be parsed', () => {
    expect(buildOssFileArtifactBlockFromUpload('tabtin oss upload /tmp/a.png', 'oops')).toBeNull();
  });

  it('builds block from successful upload stdout', () => {
    const stdout = JSON.stringify({
      ok: true,
      data: { url: ACCESS_URL, file_id: FILE_ID },
    });
    const block = buildOssFileArtifactBlockFromUpload(
      'tabtin oss upload /tmp/chart.png --format json',
      stdout,
    );
    expect(block?.payload.artifact_kind).toBe('oss_file');
    expect(block?.payload.filename).toBe('chart.png');
  });
});
