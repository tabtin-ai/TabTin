import { describe, expect, it, vi } from 'vitest';
import type { EngineHooks } from '@tabtin/agent-runtime';
import { createFileEditPatchPersistHook } from '../../src/delivery/file-edit-patch-hook.js';
import type { FileEditPatch } from '../../src/tools/file-edit-patch.js';

type AfterToolResultContext = Parameters<NonNullable<EngineHooks['afterToolResult']>>[0];

function patch(): FileEditPatch {
  return {
    toolName: 'edit_file',
    relativePath: 'a.ts',
    status: 'modified',
    before: 'old',
    after: 'new',
  };
}

describe('createFileEditPatchPersistHook', () => {
  it('persists successful editor patches and clears hostMetadata', async () => {
    const persist = vi.fn(async () => undefined);
    const hook = createFileEditPatchPersistHook({
      persist,
      resolveThreadId: () => 'thread-1',
    });
    const result = {
      content: '{"success":true}',
      hostMetadata: { fileEditPatch: patch() },
    };
    const rawResult = {
      content: '{"success":true}',
      hostMetadata: { fileEditPatch: patch() },
    };
    await hook.afterToolResult?.({
      results: [{
        toolName: 'edit_file',
        toolUseId: 'tu_1',
        input: { path: 'a.ts' },
        result,
        rawResult,
        durationMs: 1,
      }],
    } as AfterToolResultContext);

    expect(persist).toHaveBeenCalledWith({
      threadId: 'thread-1',
      toolUseId: 'tu_1',
      patch: patch(),
    });
    expect(result.hostMetadata).toBeUndefined();
    expect(rawResult.hostMetadata).toBeUndefined();
  });

  it('ignores terminal commands and missing patches', async () => {
    const persist = vi.fn(async () => undefined);
    const hook = createFileEditPatchPersistHook({
      persist,
      resolveThreadId: () => 'thread-1',
    });
    await hook.afterToolResult?.({
      results: [{
        toolName: 'run_terminal_command',
        toolUseId: 'tu_sh',
        input: { command: 'echo hi > a.ts' },
        result: { content: 'ok', hostMetadata: { command: 'echo hi' } },
        durationMs: 1,
      }, {
        toolName: 'edit_file',
        toolUseId: 'tu_fail',
        input: { path: 'a.ts' },
        result: { content: '{"success":false}', isError: true },
        durationMs: 1,
      }],
    } as AfterToolResultContext);
    expect(persist).not.toHaveBeenCalled();
  });
});
