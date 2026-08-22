/**
 * onnxruntime 推理子进程入口（Electron 侧薄壳）—— 方案 B 进程隔离。
 *
 * 由 electron.vite 作为独立 input 打包为 `out/main/onnx-embed-child.mjs`，由
 * `ProcessIsolatedBackend` 通过 `child_process.fork`（ELECTRON_RUN_AS_NODE）拉起。
 * 真正的消息循环与 onnxruntime 加载都在 `@tabtin/local-embedding` 包里；这里只负责
 * 在子进程里启动它，使主进程侧的 bundle 不牵入 onnxruntime。
 */

import { runOnnxEmbedChild } from '@tabtin/local-embedding'

runOnnxEmbedChild()
