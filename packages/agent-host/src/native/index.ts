/**
 * Native backend 宿主装配（ Stage 6d）。
 *
 * 自 agent-runtime 迁入：bootstrap 依赖 `@tabtin/terminal-core`，属宿主层。
 */

export {
  bootstrapNativeBackend,
  isNativeBackendSessionEnabled,
  NATIVE_BACKEND_ID,
} from './host-bootstrap.js';
export type {
  NativeBackendBootstrapInit,
  NativeBackendBootstrapResult,
} from './host-bootstrap.js';
