export { LocalEmbeddingService } from './local-embedding-service.js';
export type { LocalEmbeddingServiceOptions } from './local-embedding-service.js';
export { createSemanticScorer } from './semantic-scorer.js';
export type { EmbeddingBackend } from './backend.js';
export { OnnxBackend } from './backend.js';
export {
  DEFAULT_MODEL_ID,
  EMBEDDING_DIMS,
  MODEL_FILE_RELATIVE_PATH,
  TOKENIZER_FILENAME,
} from './constants.js';
// 方案 B（进程隔离）：子进程 entry 由宿主薄壳调用；ProcessIsolatedBackend 由 service 内部使用。
export { runOnnxEmbedChild } from './onnx-child-entry.js';
export { ProcessIsolatedBackend } from './process-isolated-backend.js';
export type { ProcessIsolatedBackendOptions, ForkOnnxChild, IsolatedChild } from './process-isolated-backend.js';
