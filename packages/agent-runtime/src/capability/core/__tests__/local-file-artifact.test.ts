import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  buildLocalFileArtifactBlock,
  resolveLocalFileArtifactTarget,
  statLocalFileArtifact,
  stripShellPathQuotes,
} from '../local-file-artifact.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-file-artifact-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 宿主注入：复现产品当前 tabtin:// artifact URL 模板。
const buildArtifactUrl = (relativePath: string): string =>
  `tabtin://resource/file/${encodeURIComponent(relativePath)}?hint=tabfiles`;

function writeWorkspaceFile(relativePath: string, contents = 'data'): void {
  const abs = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

describe('stripShellPathQuotes', () => {
  it('剥成对与孤立引号 ', () => {
    expect(stripShellPathQuotes('245TES.f30280.m4a"')).toBe('245TES.f30280.m4a');
    expect(stripShellPathQuotes('"artifacts/a.m4a"')).toBe('artifacts/a.m4a');
    expect(stripShellPathQuotes("'artifacts/a.m4a'")).toBe('artifacts/a.m4a');
  });
});

describe('buildLocalFileArtifactBlock', () => {
  it('构造 local_file payload，file_type / mime 由调用方提供', () => {
    const block = buildLocalFileArtifactBlock({
      fileType: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      relativePath: 'artifacts/report.xlsx',
      fileSize: 12345,
      buildUrl: buildArtifactUrl,
      autoOpen: true,
    });
    expect(block.kind).toBe('file');
    expect(block.payload).toMatchObject({
      artifact_kind: 'local_file',
      file_type: 'xlsx',
      relative_path: 'artifacts/report.xlsx',
      filename: 'report.xlsx',
      url: 'tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      file_size: 12345,
      auto_open: true,
    });
    expect(typeof block.payload.auto_open_token).toBe('string');
  });
});

describe('local file artifact helpers', () => {
  it('stat 已存在文件并构造卡片，不泄露绝对路径', async () => {
    writeWorkspaceFile('artifacts/demo.xlsx', 'workbook-bytes');
    const target = await statLocalFileArtifact(tmpDir, 'artifacts/demo.xlsx')

    expect(target).toMatchObject({
      ok: true,
      fileType: 'xlsx',
      relativePath: 'artifacts/demo.xlsx',
      fileSize: 'workbook-bytes'.length,
    })
    if (!target.ok) throw new Error(target.error)
    const block = buildLocalFileArtifactBlock({
      fileType: target.fileType,
      mimeType: target.mimeType,
      relativePath: target.relativePath,
      fileSize: target.fileSize,
      buildUrl: buildArtifactUrl,
      summary: 'demo.xlsx',
      autoRegister: true,
      autoOpen: true,
    })
    expect(block.payload).toMatchObject({
      artifact_kind: 'local_file',
      file_type: 'xlsx',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      auto_register: true,
      auto_open: true,
    });
    expect(JSON.stringify(block)).not.toContain(tmpDir);
  });

  it('未知扩展名也能 stat，mime 兜底 octet-stream', async () => {
    writeWorkspaceFile('artifacts/data.bin', 'x');
    const target = await statLocalFileArtifact(tmpDir, 'artifacts/data.bin')
    expect(target).toMatchObject({ ok: true, fileType: 'bin', mimeType: 'application/octet-stream' });
  });

  it('图片扩展名 stat 时带正确 mime', async () => {
    writeWorkspaceFile('artifacts/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const target = await statLocalFileArtifact(tmpDir, 'artifacts/diagram.svg')
    expect(target).toMatchObject({ ok: true, fileType: 'svg', mimeType: 'image/svg+xml' });
  });

  it('拒绝无工作目录 / 绝对路径 / 越界 / 无扩展名 / 不存在文件', async () => {
    writeWorkspaceFile('artifacts/exist.pdf', '%PDF-1.4')
    const cases: Array<[unknown, string | undefined]> = [
      [{ relative_path: 'artifacts/exist.pdf' }, undefined],
      [{ relative_path: path.join(tmpDir, 'artifacts/exist.pdf') }, tmpDir],
      [{ relative_path: '../exist.pdf' }, tmpDir],
      [{ relative_path: 'artifacts/noext' }, tmpDir],
      [{ relative_path: 'artifacts/missing.pdf' }, tmpDir],
    ];
    for (const [input, workspaceRoot] of cases) {
      const result = await statLocalFileArtifact(workspaceRoot, (input as Record<string, unknown>).relative_path);
      expect(result.ok).toBe(false);
    }
  });

  it('resolveTarget 可单独做路径安全校验', () => {
    expect(resolveLocalFileArtifactTarget(tmpDir, 'artifacts/a.pdf')).toMatchObject({
      ok: true,
      relativePath: 'artifacts/a.pdf',
      fileType: 'pdf',
    })
    expect(resolveLocalFileArtifactTarget(tmpDir, '../a.pdf')).toMatchObject({ ok: false })
  });

  it('relative_path 带尾引号时剥掉后发布到真实文件 ', async () => {
    writeWorkspaceFile('artifacts/clip.m4a', 'audio-bytes');
    const target = await statLocalFileArtifact(tmpDir, 'artifacts/clip.m4a"')
    expect(target).toMatchObject({ ok: true, relativePath: 'artifacts/clip.m4a' });
  });
});
