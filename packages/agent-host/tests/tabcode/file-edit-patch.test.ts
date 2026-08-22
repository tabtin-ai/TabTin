import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReadFileState, ToolContext } from '@tabtin/agent-runtime';
import {
  buildFileEditPatch,
  captureFileBeforeSnapshot,
  MAX_FILE_EDIT_PATCH_CHARS,
  readFileEditPatch,
  relativizeWorkspacePath,
} from '../../src/tools/file-edit-patch.js';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-edit-patch-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(state?: ReadFileState): ToolContext {
  return {
    threadId: 'test',
    runtimeId: 'test',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    readFileState: state,
  };
}

function getTool(name: string) {
  const tool = createTabCodeTools().find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('buildFileEditPatch', () => {
  it('uses matched old/new lines for edit_file, not the whole file', () => {
    const patch = buildFileEditPatch({
      toolName: 'edit_file',
      relativePath: 'a.ts',
      before: { kind: 'text', text: 'keep\nhello\nkeep\n' },
      input: { path: 'a.ts', old_string: 'hello', new_string: 'hi' },
      data: { old_lines: ['hello'], new_lines: ['hi'] },
    });
    expect(patch).toEqual({
      toolName: 'edit_file',
      relativePath: 'a.ts',
      status: 'modified',
      before: 'hello',
      after: 'hi',
      beforeFull: 'keep\nhello\nkeep\n',
    });
  });

  it('attaches afterFull from the post-write snapshot for edit_file', () => {
    const patch = buildFileEditPatch({
      toolName: 'edit_file',
      relativePath: 'a.ts',
      before: { kind: 'text', text: 'keep\nhello\nkeep\n' },
      after: { kind: 'text', text: 'keep\nhi\nkeep\n' },
      input: { path: 'a.ts', old_string: 'hello', new_string: 'hi' },
      data: { old_lines: ['hello'], new_lines: ['hi'] },
    });
    expect(patch).toMatchObject({
      before: 'hello',
      after: 'hi',
      beforeFull: 'keep\nhello\nkeep\n',
      afterFull: 'keep\nhi\nkeep\n',
    });
  });

  it('marks failed-shape edit_file without old_lines as unreadable', () => {
    const patch = buildFileEditPatch({
      toolName: 'edit_file',
      relativePath: 'a.ts',
      before: { kind: 'text', text: 'hello' },
      input: { path: 'a.ts' },
      data: { success: true },
    });
    expect(patch.status).toBe('unreadable');
    expect(patch.before).toBeUndefined();
    expect(patch.after).toBeUndefined();
  });

  it('captures write_file create / overwrite / append', () => {
    expect(buildFileEditPatch({
      toolName: 'write_file',
      relativePath: 'new.ts',
      before: { kind: 'absent' },
      input: { path: 'new.ts', contents: 'created' },
    })).toMatchObject({ status: 'added', after: 'created', afterFull: 'created' });

    expect(buildFileEditPatch({
      toolName: 'write_file',
      relativePath: 'old.ts',
      before: { kind: 'text', text: 'before' },
      input: { path: 'old.ts', contents: 'after' },
    })).toMatchObject({
      status: 'modified',
      before: 'before',
      after: 'after',
      beforeFull: 'before',
      afterFull: 'after',
    });

    expect(buildFileEditPatch({
      toolName: 'write_file',
      relativePath: 'log.ts',
      before: { kind: 'text', text: 'a' },
      input: { path: 'log.ts', contents: 'b', append: true },
    })).toMatchObject({
      status: 'modified',
      before: 'a',
      after: 'ab',
      beforeFull: 'a',
      afterFull: 'ab',
    });
  });

  it('captures delete_file before text', () => {
    expect(buildFileEditPatch({
      toolName: 'delete_file',
      relativePath: 'gone.ts',
      before: { kind: 'text', text: 'bye' },
      input: { path: 'gone.ts' },
    })).toMatchObject({ status: 'deleted', before: 'bye', beforeFull: 'bye' });
  });

  it('marks binary and oversized snapshots unreadable without forging text', () => {
    expect(buildFileEditPatch({
      toolName: 'write_file',
      relativePath: 'a.bin',
      before: { kind: 'binary' },
      input: { path: 'a.bin', contents: 'x' },
    })).toMatchObject({ status: 'unreadable', binary: true });

    expect(buildFileEditPatch({
      toolName: 'edit_file',
      relativePath: 'huge.ts',
      before: { kind: 'too_large' },
      input: { path: 'huge.ts' },
      data: { old_lines: ['a'], new_lines: ['b'] },
    })).toMatchObject({ status: 'unreadable', truncated: true });

    const huge = 'x'.repeat(MAX_FILE_EDIT_PATCH_CHARS + 1);
    expect(buildFileEditPatch({
      toolName: 'write_file',
      relativePath: 'huge.ts',
      before: { kind: 'absent' },
      input: { path: 'huge.ts', contents: huge },
    })).toMatchObject({ status: 'unreadable', truncated: true });
  });
});

describe('captureFileBeforeSnapshot', () => {
  it('reads text, reports absent, and detects binary', async () => {
    const file = path.join(tmpDir, 'a.txt');
    await fsPromises.writeFile(file, 'hello\n', 'utf8');
    await expect(captureFileBeforeSnapshot(file)).resolves.toEqual({ kind: 'text', text: 'hello\n' });
    await expect(captureFileBeforeSnapshot(path.join(tmpDir, 'missing.txt'))).resolves.toEqual({
      kind: 'absent',
    });
    const bin = path.join(tmpDir, 'a.bin');
    await fsPromises.writeFile(bin, Buffer.from([0x00, 0x01, 0x02]));
    await expect(captureFileBeforeSnapshot(bin)).resolves.toEqual({ kind: 'binary' });
  });
});

describe('readFileEditPatch / relativizeWorkspacePath', () => {
  it('guards hostMetadata shape', () => {
    expect(readFileEditPatch(undefined)).toBeNull();
    expect(readFileEditPatch({ fileEditPatch: { toolName: 'run_terminal_command' } })).toBeNull();
    expect(readFileEditPatch({
      fileEditPatch: {
        toolName: 'edit_file',
        relativePath: 'a.ts',
        status: 'modified',
        before: 'a',
        after: 'b',
        beforeFull: 'aa',
        afterFull: 'bb',
      },
    })).toMatchObject({
      toolName: 'edit_file',
      before: 'a',
      after: 'b',
      beforeFull: 'aa',
      afterFull: 'bb',
    });
  });

  it('relativizes inside the workspace', () => {
    expect(relativizeWorkspacePath(path.join(tmpDir, 'src', 'a.ts'), tmpDir)).toBe('src/a.ts');
  });
});

describe('tabcode adapter attaches frozen patches', () => {
  it('successful edit_file attaches matched hunk, not later disk state', async () => {
    const file = path.join(tmpDir, 'b.txt');
    await fsPromises.writeFile(file, 'hello world', 'utf8');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    await getTool('read_file').execute({ path: file }, ctx);
    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'hello', new_string: 'hi' },
      ctx,
    );
    expect(editRes.isError).toBeUndefined();
    await fsPromises.writeFile(file, 'hi world\nuser changed another line', 'utf8');
    expect(editRes.hostMetadata?.fileEditPatch).toEqual({
      toolName: 'edit_file',
      relativePath: 'b.txt',
      status: 'modified',
      before: 'hello',
      after: 'hi',
      beforeFull: 'hello world',
      afterFull: 'hi world',
    });
  });

  it('failed edit_file does not attach a forged patch', async () => {
    const file = path.join(tmpDir, 'c.txt');
    await fsPromises.writeFile(file, 'hello world', 'utf8');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    await getTool('read_file').execute({ path: file }, ctx);
    const editRes = await getTool('edit_file').execute(
      { path: file, old_string: 'missing', new_string: 'nope' },
      ctx,
    );
    expect(editRes.isError).toBe(true);
    expect(editRes.hostMetadata).toBeUndefined();
  });

  it('write_file and delete_file freeze before/after at execute time', async () => {
    const created = await getTool('write_file').execute(
      { path: path.join(tmpDir, 'n.txt'), contents: 'new-file' },
      makeCtx(),
    );
    expect(created.hostMetadata?.fileEditPatch).toMatchObject({
      toolName: 'write_file',
      status: 'added',
      after: 'new-file',
      afterFull: 'new-file',
    });

    const existing = path.join(tmpDir, 'e.txt');
    await fsPromises.writeFile(existing, 'old', 'utf8');
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    await getTool('read_file').execute({ path: existing }, ctx);
    const overwritten = await getTool('write_file').execute(
      { path: existing, contents: 'fresh' },
      ctx,
    );
    expect(overwritten.hostMetadata?.fileEditPatch).toMatchObject({
      status: 'modified',
      before: 'old',
      after: 'fresh',
      beforeFull: 'old',
      afterFull: 'fresh',
    });

    const appended = await getTool('write_file').execute(
      { path: existing, contents: '+tail', append: true },
      ctx,
    );
    expect(appended.hostMetadata?.fileEditPatch).toMatchObject({
      before: 'fresh',
      after: 'fresh+tail',
      beforeFull: 'fresh',
      afterFull: 'fresh+tail',
    });

    const deleted = await getTool('delete_file').execute(
      { path: existing },
      makeCtx(),
    );
    expect(deleted.hostMetadata?.fileEditPatch).toMatchObject({
      toolName: 'delete_file',
      status: 'deleted',
      before: 'fresh+tail',
      beforeFull: 'fresh+tail',
    });
    expect(deleted.hostMetadata?.fileEditPatch).not.toHaveProperty('afterFull');
  });
});
