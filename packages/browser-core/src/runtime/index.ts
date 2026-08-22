/**
 * Runtime State —— BR-8 WS-B「状态收编进 runtime」的落点（electron-free）。
 *
 * 当前收编：
 * - network / console 历史缓冲（P2）：两端的 `BrowserContext.onCDPEvent`
 *   都喂进**共享单例**，于是 `network` / `console` 在两端都返回历史日志。
 * - RefCache（P3a）：compact snapshot 的 `eN → selector` 映射，两端 route 都填同一份、
 *   `act` 查同一份回解 `ref`/`toRef`——解锁 daemon `act` 用 snapshot 的 eN。
 * - RecordingRegistry（P3c 收尾）：活跃录制的 `tabId → {runId,startedAt}` 登记表，
 *   原 Electron `/record/*` 路由的模块级 Map 收编于此（route 层不再持跨请求 Map）。
 *
 * 一个进程只跑一个运行时（Electron 或 Daemon），单例按 tabId 分桶不会串。
 */

import { NetworkLog } from './NetworkLog';
import { ConsoleLog } from './ConsoleLog';

export { NetworkLog } from './NetworkLog';
export type { NetworkLogEntry, NetworkLogQuery, NetworkResponseBodyPatch } from './NetworkLog';
export { ConsoleLog } from './ConsoleLog';
export type { ConsoleLogEntry, ConsoleLogQuery } from './ConsoleLog';
export { RefCache, getSharedRefCache, resetSharedRefCache } from './RefCache';
export type { RefEntry } from './RefCache';
export {
  assignSemanticFingerprints,
  buildSemanticRelocateScript,
  effectiveSemanticRole,
  formatSemanticFingerprint,
  formatSemanticRelocateFailure,
  isStaleLocatorError,
  normalizeSemanticName,
  semanticKey,
} from './ref-semantic';
export type { SemanticFingerprint } from './ref-semantic';
export { RecordingRegistry, getSharedRecordingRegistry, resetSharedRecordingRegistry } from './RecordingRegistry';
export type { ActiveRecordingEntry } from './RecordingRegistry';
export { BrowserJobManager, getSharedBrowserJobManager, resetSharedBrowserJobManager, shutdownSharedBrowserJobManager } from './BrowserJobManager';
export type { BrowserJobProgress, BrowserJobStatus, BrowserJobRecord, BrowserJobHandle, BrowserJobManagerOptions } from './BrowserJobManager';
export { attachRuntimeLogCapture } from './attachRuntimeLogCapture';
export type { RuntimeLogCaptureOptions } from './attachRuntimeLogCapture';
export type { CDPLogEvent, RuntimeLogContext } from './types';

let sharedNetworkLog: NetworkLog | null = null;
let sharedConsoleLog: ConsoleLog | null = null;

/** 进程级共享网络历史缓冲。 */
export function getSharedNetworkLog(): NetworkLog {
  if (!sharedNetworkLog) sharedNetworkLog = new NetworkLog();
  return sharedNetworkLog;
}

/** 进程级共享控制台历史缓冲。 */
export function getSharedConsoleLog(): ConsoleLog {
  if (!sharedConsoleLog) sharedConsoleLog = new ConsoleLog();
  return sharedConsoleLog;
}

/** 重置共享缓冲（仅供测试隔离用）。 */
export function resetSharedRuntimeLogs(): void {
  sharedNetworkLog = null;
  sharedConsoleLog = null;
}
