import { AsyncLocalStorage } from 'node:async_hooks';

import type { RuntimeMode } from '../engine/contracts/tools.js';

export interface HumanInteractionContext {
  threadId: string;
  runtimeId?: string;
  interactionMode: RuntimeMode;
}

export interface PlatformApprovalRequest {
  actionType: string;
  detail: string;
  reason?: string;
  timeoutMs?: number;
  isStrict?: boolean;
}

export interface PlatformApprovalResult {
  approved: boolean;
  scope?: 'once' | 'thread' | 'always';
}

export interface HumanInteractionHooks {
  requestPlatformApproval(
    context: HumanInteractionContext,
    request: PlatformApprovalRequest,
  ): Promise<PlatformApprovalResult>;
}

const contextStorage = new AsyncLocalStorage<HumanInteractionContext>();
let installedHooks: HumanInteractionHooks | undefined;

/**
 * Installs the process-local host implementation used by HITL entry points.
 *
 * Electron and Daemon run in separate processes, so each process owns exactly
 * one host hook. Runtime/query identity remains request-scoped in
 * AsyncLocalStorage and is never stored in this global slot.
 */
export function setHumanInteractionHooks(hooks: HumanInteractionHooks | undefined): void {
  installedHooks = hooks;
}

export function runWithHumanInteractionContext<T>(
  context: HumanInteractionContext,
  work: () => T,
): T {
  const threadId = context.threadId.trim();
  return contextStorage.run({ ...context, threadId }, work);
}

export function getHumanInteractionContext(): HumanInteractionContext | undefined {
  return contextStorage.getStore();
}

/**
 * The only platform-action HITL entry point.
 *
 * Callers provide action semantics only. The conversation identity is injected
 * by the runtime/transport boundary through `runWithHumanInteractionContext`.
 * Missing context or host wiring fails closed.
 */
export async function requestPlatformApproval(
  request: PlatformApprovalRequest,
): Promise<PlatformApprovalResult> {
  const context = contextStorage.getStore();
  if (!context?.threadId || !installedHooks) {
    return { approved: false };
  }
  return installedHooks.requestPlatformApproval(context, request);
}
