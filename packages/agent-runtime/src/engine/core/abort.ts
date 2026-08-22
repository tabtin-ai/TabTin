/**
 * Abort helpers：主循环 / 工具执行的取消检查与 abort 错误判定。
 * 自 query.ts 抽出——被主循环、流式解码、工具执行多处共用。
 */
import {
  AgentError,
} from '../contracts/kernel.js';

export function checkAbort(controller: AbortController): void {
  if (controller.signal.aborted) {
    throw new AgentError('Run aborted', 'ABORT');
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof AgentError && error.code === 'ABORT';
}
