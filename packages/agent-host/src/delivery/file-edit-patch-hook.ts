/**
 * Host `afterToolResult` hook —— 把编辑工具临界区捕获的补丁写入本机账本。
 *
 * adapter 把 `FileEditPatch` 挂在瞬态 `hostMetadata` 上；本 hook 消费后必须清空，
 * 避免正文经其它序列化路径泄漏。失败/拒绝的工具没有补丁，终端改动也不会出现。
 */
import type { EngineHooks, ToolResult } from '@tabtin/agent-runtime';

type AfterToolResultContext = Parameters<NonNullable<EngineHooks['afterToolResult']>>[0];
import {
  FILE_EDIT_PATCH_TOOL_NAME_SET,
  readFileEditPatch,
  type FileEditPatch,
} from '../tools/file-edit-patch.js';

export interface FileEditPatchPersistInput {
  threadId: string;
  toolUseId: string;
  patch: FileEditPatch;
}

export interface FileEditPatchPersistHookDeps {
  persist: (input: FileEditPatchPersistInput) => Promise<void>;
  resolveThreadId: (ctx: AfterToolResultContext) => string | null | undefined;
}

export function createFileEditPatchPersistHook(
  deps: FileEditPatchPersistHookDeps,
): EngineHooks {
  return {
    afterToolResult: async (ctx) => {
      const threadId = deps.resolveThreadId(ctx)?.trim();
      for (const item of ctx.results) {
        if (!FILE_EDIT_PATCH_TOOL_NAME_SET.has(item.toolName)) continue;
        const result = item.result as ToolResult;
        const rawResult = item.rawResult as ToolResult | undefined;
        const patch = readFileEditPatch(result.hostMetadata)
          ?? readFileEditPatch(rawResult?.hostMetadata);
        if (!patch) {
          console.warn('[DEBUG-code-diff-review] editor patch metadata missing', {
            toolName: item.toolName,
            toolUseId: item.toolUseId,
            hasResultMetadata: Boolean(result.hostMetadata),
            hasRawResultMetadata: Boolean(rawResult?.hostMetadata),
          });
        } else if (!threadId || !item.toolUseId) {
          console.warn('[DEBUG-code-diff-review] editor patch identity missing', {
            toolName: item.toolName,
            toolUseId: item.toolUseId,
            hasThreadId: Boolean(threadId),
          });
        }
        if (threadId && item.toolUseId && patch) {
          try {
            await deps.persist({
              threadId,
              toolUseId: item.toolUseId,
              patch,
            });
          } catch {
            // fail-soft：账本失败不阻断工具结果回传；清掉元数据以免泄漏正文。
          }
        }
        result.hostMetadata = undefined;
        if (rawResult) rawResult.hostMetadata = undefined;
      }
    },
  };
}
