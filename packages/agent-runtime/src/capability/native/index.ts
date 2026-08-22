/**
 * `@tabtin/agent-runtime/capability/native` —— NativeBackendSession 子 barrel。
 *
 *  Stage 6d：`bootstrapNativeBackend` 已迁至宿主包的 `native`
 * 子路径（装配依赖 terminal-core）。本路径只保留 session 实现本身。
 *
 *   import {
 *     NativeBackendSession,
 *     NativeBackendSessionUnsupportedError,
 *   } from '@tabtin/agent-runtime/capability/native';
 */

export {
  NativeBackendSession,
  NativeBackendSessionUnsupportedError,
} from './native-backend-session.js';
export type { NativeBackendSessionInit } from './native-backend-session.js';
export type { SafeFsPort, SafeFsStatLike } from './safe-fs-port.js';
