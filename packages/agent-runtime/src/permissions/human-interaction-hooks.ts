import { AsyncLocalStorage } from 'node:async_hooks';

import type { RuntimeMode } from '../engine/contracts/tools.js';
import type { AccessBarrier, AccessBarrierResolution } from '../access-barrier/present.js';

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
  /**
   * Access Barrier HITL：宿主把 CLI/FC 浏览器编排出口拿到的 `AccessBarrier` 转成对话卡片
   * 并等决议。可选——未注入时 `requestAccessBarrierResolution` 直接诚实失败
   * （`host_unavailable`），不空转 glance。
   */
  resolveAccessBarrier?(
    context: HumanInteractionContext,
    barrier: AccessBarrier,
  ): Promise<AccessBarrierResolution>;
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

/**
 * Access Barrier HITL 出口（设计 §8.3 CLI-first 接线）：`BrowserOrchestratorHostHooks.
 * resolveAccessBarrier` 的宿主实装从这里取得当前会话的 HITL 通道。缺上下文
 * （未经 `runWithHumanInteractionContext` 包裹）或宿主未注册 `resolveAccessBarrier`
 * 时诚实失败（fail-closed）——禁止假装成功或静默换源。
 */
export async function requestAccessBarrierResolution(
  barrier: AccessBarrier,
): Promise<AccessBarrierResolution> {
  const context = contextStorage.getStore();
  if (!context?.threadId || !installedHooks?.resolveAccessBarrier) {
    return { action: 'host_unavailable' };
  }
  return installedHooks.resolveAccessBarrier(context, barrier);
}
