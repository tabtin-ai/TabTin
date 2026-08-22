/**
 * OnnxBackend.embed 分批调度测试（不依赖真模型）。
 *
 * 回归「大语料一次性灌进单次 ONNX Run → ORT 内存顶爆 → C++ abort() →
 * 宿主进程 SIGABRT」的崩溃（详见 constants.EMBED_BATCH_SIZE）：验证 embed
 * 把大批切成 ≤ EMBED_BATCH_SIZE 的多次前向，且批间顺序拼接、结果与输入一一对应。
 *
 * 手法：覆写实例的私有 `embedBatch`（运行时可行），记录每次批大小并返回
 * 可回溯输入的标记向量，从而只测调度逻辑、不加载 onnxruntime。
 */

import { describe, expect, it } from 'vitest';
import { OnnxBackend } from '../backend.js';
import { EMBED_BATCH_SIZE } from '../constants.js';

function makeBackend(recordSizes: number[]): OnnxBackend {
  const backend = new OnnxBackend({ modelDir: '/nonexistent', dims: 1 });
  // 覆写单批前向：不触碰 onnxruntime，返回把「原文本首个字符的 charCode」编码进
  // 向量的标记，便于断言顺序与一一对应。
  (backend as unknown as { embedBatch: (t: string[]) => Promise<Float32Array[]> }).embedBatch =
    async (texts: string[]) => {
      recordSizes.push(texts.length);
      return texts.map((t) => Float32Array.from([t.charCodeAt(0)]));
    };
  return backend;
}

describe('OnnxBackend.embed 分批调度', () => {
  it('空输入直接返回空，不触发前向', async () => {
    const sizes: number[] = [];
    const backend = makeBackend(sizes);
    expect(await backend.embed([])).toEqual([]);
    expect(sizes).toEqual([]);
  });

  it('小于等于批上限：单次前向', async () => {
    const sizes: number[] = [];
    const backend = makeBackend(sizes);
    const texts = Array.from({ length: EMBED_BATCH_SIZE }, (_, i) => String.fromCharCode(65 + i));
    const out = await backend.embed(texts);
    expect(out).toHaveLength(EMBED_BATCH_SIZE);
    expect(sizes).toEqual([EMBED_BATCH_SIZE]); // 只调一次
  });

  it('大批被切成多次前向，每次 ≤ 上限，顺序与内容一一对应', async () => {
    const sizes: number[] = [];
    const backend = makeBackend(sizes);
    // 用 755 复刻真实事故规模（755 条 skills）
    const N = 755;
    const texts = Array.from({ length: N }, (_, i) => String.fromCharCode(33 + (i % 90)));
    const out = await backend.embed(texts);

    // 结果条数与顺序：逐条与输入首字符对应
    expect(out).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(out[i]![0]).toBe(texts[i].charCodeAt(0));
    }
    // 分批次数 = ceil(N / 上限)，且每批都不超过上限
    const expectedCalls = Math.ceil(N / EMBED_BATCH_SIZE);
    expect(sizes).toHaveLength(expectedCalls);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(N);
  });
});
