/**
 * onnxruntime 进程隔离（方案 B）的父子进程 IPC 协议。
 *
 * 单独成文件，让子进程 entry 与宿主侧 `ProcessIsolatedBackend` 共享同一份类型，
 * 避免协议漂移。走 `child_process` advanced 序列化，`Float32Array` 可直接传输。
 */

/** 父 → 子。 */
export type ChildInboundMessage =
  | { type: 'load'; modelDir: string; dims: number }
  | { type: 'embed'; id: number; texts: string[] };

/** 子 → 父。 */
export type ChildOutboundMessage =
  | { type: 'loaded' }
  | { type: 'load_error'; message: string }
  | { type: 'embedded'; id: number; vectors: Float32Array[] }
  | { type: 'embed_error'; id: number; message: string };
