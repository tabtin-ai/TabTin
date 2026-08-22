/**
 * onnxruntime 推理子进程入口 —— 进程隔离（方案 B）。
 *
 * **为什么要独立子进程**：onnxruntime 是同进程 C++ 原生库，推理时若命中致命
 * 状况会走 `std::terminate()` → `abort()`，直接 SIGABRT **整个宿主进程**——JS
 * `try/catch` 拦不住，`worker_threads` 也救不了（abort 杀的是进程、连所有线程）。
 * 唯一能隔离的是把 ORT 关进**独立 OS 进程**：它崩了只死子进程，宿主侧
 * `ProcessIsolatedBackend` 收到 exit 事件 → 拒绝在途请求 → 上层降级词法召回，
 * 主进程/主窗口毫发无损。
 *
 * 协议（父 → 子 / 子 → 父，见 `isolation-protocol.ts`），走 `child_process`
 * 的 advanced 序列化（可直接传 Float32Array）。子进程只负责：load 一次模型、
 * 按请求 embed、把结果/错误回传。任何未预期异常都转成 error 消息回传而非静默。
 */

import { OnnxBackend } from './backend.js';
import type {
  ChildInboundMessage,
  ChildOutboundMessage,
} from './isolation-protocol.js';

/**
 * 启动子进程消息循环。由各宿主的薄 entry（如 Electron 的
 * `onnx-embed-child.mjs`）在子进程里调用一次。
 */
export function runOnnxEmbedChild(): void {
  let backend: OnnxBackend | null = null;

  const send = (msg: ChildOutboundMessage): void => {
    process.send?.(msg);
  };

  process.on('message', (raw: ChildInboundMessage) => {
    void handle(raw);
  });

  async function handle(msg: ChildInboundMessage): Promise<void> {
    if (msg.type === 'load') {
      try {
        backend = new OnnxBackend({ modelDir: msg.modelDir, dims: msg.dims });
        await backend.load();
        send({ type: 'loaded' });
      } catch (err) {
        backend = null;
        send({ type: 'load_error', message: errMsg(err) });
      }
      return;
    }
    if (msg.type === 'embed') {
      if (!backend) {
        send({ type: 'embed_error', id: msg.id, message: '模型尚未加载' });
        return;
      }
      try {
        const vectors = await backend.embed(msg.texts);
        send({ type: 'embedded', id: msg.id, vectors });
      } catch (err) {
        send({ type: 'embed_error', id: msg.id, message: errMsg(err) });
      }
      return;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
