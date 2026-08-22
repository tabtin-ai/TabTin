/**
 * shell-file-history · 单测（ / W2-5-C）
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileHistorySink } from '../../engine/types.js';
import {
  SHELL_FILE_HISTORY_EXCLUDED_DIR_NAMES,
  SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS,
  SHELL_FILE_HISTORY_MAX_SCAN_FILES,
  buildShellFileHistoryEnvelope,
  diffWorkspaceSnapshots,
  prepareShellFileHistoryTracking,
  resetShellFileHistoryTurnBaselineCacheForTests,
  scanWorkspaceFiles,
} from '../shell-file-history.js';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'shell-fh-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

class RecordingFileHistory implements FileHistorySink {
  readonly edits: Array<{ anchorId: string; absPath: string }> = [];
  async beginSnapshot(_anchorId: string): Promise<void> {}
  async trackEdit(anchorId: string, absPath: string): Promise<void> {
    this.edits.push({ anchorId, absPath });
  }
}

describe('scanWorkspaceFiles', () => {
  it('排除 node_modules / .git 等目录', async () => {
    await fsPromises.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    await fsPromises.mkdir(path.join(tmpDir, '.git', 'objects'), { recursive: true });
    await fsPromises.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fsPromises.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'x');
    await fsPromises.writeFile(path.join(tmpDir, '.git', 'objects', 'x'), 'x');
    await fsPromises.writeFile(path.join(tmpDir, 'src', 'ok.ts'), 'ok');

    const scan = await scanWorkspaceFiles(tmpDir);
    expect(scan.snapshot.has(path.resolve(tmpDir, 'src', 'ok.ts'))).toBe(true);
    expect(scan.snapshot.has(path.resolve(tmpDir, 'node_modules', 'pkg', 'index.js'))).toBe(false);
    expect(scan.snapshot.has(path.resolve(tmpDir, '.git', 'objects', 'x'))).toBe(false);
  });

  it('扫描文件数达上限时 scanTruncated=true', async () => {
    await fsPromises.mkdir(path.join(tmpDir, 'many'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await fsPromises.writeFile(path.join(tmpDir, 'many', `f${i}.txt`), `${i}`);
    }

    const scan = await scanWorkspaceFiles(tmpDir, { maxFiles: 3 });
    expect(scan.scannedFiles).toBe(3);
    expect(scan.scanTruncated).toBe(true);
  });
});

describe('prepareShellFileHistoryTracking + buildShellFileHistoryEnvelope', () => {
  it('spawn 前 pre-track 扫描到的文件，post diff 识别 modified', async () => {
    const target = path.join(tmpDir, 'a.txt');
    await fsPromises.writeFile(target, 'before');

    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-1',
    });

    expect(pre.preTrack.trackedCount).toBe(1);
    expect(fh.edits).toHaveLength(1);
    expect(fh.edits[0].anchorId).toBe('run-1');
    expect(fh.edits[0].absPath).toBe(path.resolve(target));

    await fsPromises.writeFile(target, 'after');

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
    });

    expect(envelope?.status).toBe('complete');
    expect(envelope?.modified_count).toBe(1);
    expect(envelope?.degraded).toBe(false);
    expect(envelope?.tracked_count).toBe(1);
  });

  it('同一轮同一 workspace 的 shell baseline 只 pre-track 一次，后续工具复用', async () => {
    const first = path.join(tmpDir, 'first.txt');
    await fsPromises.writeFile(first, 'before');

    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-turn-cache',
    });
    expect(pre.preTrack.trackedCount).toBe(1);
    expect(fh.edits).toHaveLength(1);

    await fsPromises.writeFile(path.join(tmpDir, 'second.txt'), 'created-after-baseline');
    const reused = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-turn-cache',
    });

    expect(reused.preSnapshot).toBe(pre.preSnapshot);
    expect(reused.preTrack).toBe(pre.preTrack);
    expect(fh.edits).toHaveLength(1);

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: reused.preSnapshot,
      preTrack: reused.preTrack,
    });
    expect(envelope?.created_paths).toEqual(['second.txt']);
    expect(envelope?.created_untracked_count).toBe(1);

    resetShellFileHistoryTurnBaselineCacheForTests(fh);
  });

  it('无 fileHistory 时不扫描 workspace', async () => {
    await fsPromises.writeFile(path.join(tmpDir, 'x.txt'), 'x');
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      agentRunId: 'run-no-fh-fast',
    });

    expect(pre.preSnapshot).toBeUndefined();
    expect(pre.preTrack.skippedReason).toBe('no_file_history');
    expect(pre.preTrack.scanTruncated).toBe(false);
  });

  it('无 anchor 时不扫描 workspace', async () => {
    await fsPromises.writeFile(path.join(tmpDir, 'x.txt'), 'x');
    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
    });

    expect(pre.preSnapshot).toBeUndefined();
    expect(pre.preTrack.skippedReason).toBe('no_anchor');
    expect(fh.edits).toHaveLength(0);
  });

  it('新建文件计入 created_untracked 并 degraded', async () => {
    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      fileHistoryAnchorId: 'parent-anchor',
      agentRunId: 'child-run',
    });

    const created = path.join(tmpDir, 'new.txt');
    await fsPromises.writeFile(created, 'new');

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
    });

    expect(envelope?.created_untracked_count).toBe(1);
    expect(envelope?.degraded).toBe(true);
    expect(envelope?.degraded_reason).toBe('created_files');
    expect(fh.edits.some((e) => e.absPath === path.resolve(created))).toBe(false);
  });

  it('扫描超限时 degraded_reason=scan_limit', async () => {
    await fsPromises.mkdir(path.join(tmpDir, 'bulk'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      await fsPromises.writeFile(path.join(tmpDir, 'bulk', `f${i}.txt`), `${i}`);
    }

    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-scan-cap',
    });

    // pre-track 只覆盖扫描到的 2 个；post-scan 同样受 cap 影响
    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: {
        ...pre.preTrack,
        scanTruncated: true,
      },
    });

    expect(envelope?.scan_truncated).toBe(true);
    expect(envelope?.degraded).toBe(true);
    expect(envelope?.degraded_reason).toBe('scan_limit');
  });

  it('无 fileHistory 时 skipped + degraded', async () => {
    await fsPromises.writeFile(path.join(tmpDir, 'x.txt'), 'x');
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      agentRunId: 'run-no-fh',
    });

    expect(pre.preSnapshot).toBeUndefined();
    expect(pre.preTrack.skippedReason).toBe('no_file_history');
    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
    });
    expect(envelope?.status).toBe('skipped');
    expect(envelope?.scan_truncated).toBe(false);
    expect(envelope?.degraded_reason).toBe('no_file_history');
  });

  it('envelope 携带 created_paths / modified_paths / deleted_paths（workspace 相对路径，POSIX 分隔）', async () => {
    const existing = path.join(tmpDir, 'docs', 'old.md');
    await fsPromises.mkdir(path.dirname(existing), { recursive: true });
    await fsPromises.writeFile(existing, 'before');
    const toRemove = path.join(tmpDir, 'artifacts', 'scratch.tmp.bin');
    await fsPromises.mkdir(path.dirname(toRemove), { recursive: true });
    await fsPromises.writeFile(toRemove, 'intermediate');

    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-paths',
    });

    await fsPromises.writeFile(existing, 'after-with-longer-content');
    await fsPromises.writeFile(path.join(tmpDir, 'artifacts', 'test.dmg'), 'dmg-bytes');
    await fsPromises.rm(toRemove);

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
    });

    expect(envelope?.created_paths).toEqual(['artifacts/test.dmg']);
    expect(envelope?.modified_paths).toEqual(['docs/old.md']);
    expect(envelope?.deleted_paths).toEqual(['artifacts/scratch.tmp.bin']);
    expect(envelope?.paths_truncated).toBeUndefined();
  });

  it('无变更时不写 created_paths / modified_paths 字段', async () => {
    await fsPromises.writeFile(path.join(tmpDir, 'stable.txt'), 'same');
    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-nochange',
    });

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
    });

    expect(envelope?.created_paths).toBeUndefined();
    expect(envelope?.modified_paths).toBeUndefined();
  });

  it('created_paths 超上限截断并置 paths_truncated', async () => {
    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-truncate',
    });

    await fsPromises.mkdir(path.join(tmpDir, 'out'), { recursive: true });
    for (let i = 0; i < SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS + 5; i++) {
      await fsPromises.writeFile(path.join(tmpDir, 'out', `f${i}.txt`), `${i}`);
    }

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
    });

    expect(envelope?.created_paths).toHaveLength(SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS);
    expect(envelope?.paths_truncated).toBe(true);
  });

  it('deferred 不携带路径字段', async () => {
    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-deferred-paths',
    });
    await fsPromises.writeFile(path.join(tmpDir, 'bg.txt'), 'x');

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
      deferred: true,
    });

    expect(envelope?.created_paths).toBeUndefined();
    expect(envelope?.modified_paths).toBeUndefined();
  });

  it('background deferred 标记 degraded', async () => {
    const fh = new RecordingFileHistory();
    const pre = await prepareShellFileHistoryTracking({
      workspaceRoot: tmpDir,
      fileHistory: fh,
      agentRunId: 'run-bg',
    });

    const envelope = await buildShellFileHistoryEnvelope({
      workspaceRoot: tmpDir,
      preSnapshot: pre.preSnapshot,
      preTrack: pre.preTrack,
      deferred: true,
    });

    expect(envelope?.status).toBe('deferred');
    expect(envelope?.degraded_reason).toBe('background_deferred');
  });
});

describe('diffWorkspaceSnapshots', () => {
  it('识别 deleted', () => {
    const before = new Map([
      ['/a', { mtimeMs: 1, size: 1 }],
      ['/b', { mtimeMs: 2, size: 2 }],
    ]);
    const after = new Map([['/a', { mtimeMs: 1, size: 1 }]]);
    const changes = diffWorkspaceSnapshots(before, after);
    expect(changes).toEqual([{ absPath: '/b', kind: 'deleted' }]);
  });
});

describe('常量护栏', () => {
  it('默认排除目录包含 node_modules 与 .git', () => {
    expect(SHELL_FILE_HISTORY_EXCLUDED_DIR_NAMES.has('node_modules')).toBe(true);
    expect(SHELL_FILE_HISTORY_EXCLUDED_DIR_NAMES.has('.git')).toBe(true);
  });

  it('默认扫描上限为 500', () => {
    expect(SHELL_FILE_HISTORY_MAX_SCAN_FILES).toBe(500);
  });
});
