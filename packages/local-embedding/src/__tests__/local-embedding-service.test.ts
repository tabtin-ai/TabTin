import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingBackend } from '../backend.js';
import {
  EMBEDDING_DIMS,
  PASSAGE_PREFIX,
  QUERY_PREFIX,
  WARMUP_RETRY_INTERVAL_MS,
} from '../constants.js';
import { LocalEmbeddingService } from '../local-embedding-service.js';
import { createSemanticScorer } from '../semantic-scorer.js';

/**
 * 假后端：记录调用，按文本内容生成确定性的归一化向量。
 * 「screenshot 语义组」的文本返回同一方向的向量，方便断言相似度。
 */
class FakeBackend implements EmbeddingBackend {
  loadCalls = 0;
  embedCalls: string[][] = [];
  failLoad = false;
  failEmbed = false;

  async load(): Promise<void> {
    this.loadCalls += 1;
    if (this.failLoad) throw new Error('download failed');
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    if (this.failEmbed) throw new Error('inference failed');
    return texts.map((t) => {
      const vec = new Float32Array(EMBEDDING_DIMS);
      // 语义组：含「截图」或 screenshot 的文本共享维度 0；其他文本按首字符散开
      if (/截图|screenshot/i.test(t)) {
        vec[0] = 1;
      } else {
        vec[1 + (t.charCodeAt(t.length - 1) % (EMBEDDING_DIMS - 1))] = 1;
      }
      return vec;
    });
  }
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'local-embedding-test-'));
}

async function makeService(backend: EmbeddingBackend) {
  const dir = await tmpDir();
  return new LocalEmbeddingService({
    backend,
    cacheDir: path.join(dir, 'cache'),
    modelsDir: path.join(dir, 'models'),
  });
}

describe('LocalEmbeddingService 就绪状态', () => {
  it('warmup 前所有接口返回 null / 缓存未命中为 null', async () => {
    const service = await makeService(new FakeBackend());
    expect(service.isReady()).toBe(false);
    expect(await service.embedQuery('随便')).toBeNull();
    expect(await service.embedPassages(['a', 'b'])).toEqual([null, null]);
  });

  it('warmup 幂等：并发调用只 load 一次', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await Promise.all([service.warmup(), service.warmup(), service.warmup()]);
    expect(backend.loadCalls).toBe(1);
    expect(service.isReady()).toBe(true);
  });

  it('warmup 失败后可重试', async () => {
    const backend = new FakeBackend();
    backend.failLoad = true;
    const service = await makeService(backend);
    await expect(service.warmup()).rejects.toThrow('download failed');
    expect(service.isReady()).toBe(false);
    backend.failLoad = false;
    await service.warmup();
    expect(service.isReady()).toBe(true);
  });

  describe('warmup 失败后的惰性重试（embed 调用触发，节流）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('节流窗口内不重试；越过窗口后 embed 调用触发后台重试并恢复', async () => {
      vi.useFakeTimers({ toFake: ['Date'] }); // 只伪造 Date，setTimeout 保持真实
      const backend = new FakeBackend();
      backend.failLoad = true;
      const service = await makeService(backend);
      await expect(service.warmup()).rejects.toThrow('download failed');
      expect(backend.loadCalls).toBe(1);

      // 失败后立即 embed：仍在节流窗口内，不触发重试
      expect(await service.embedQuery('x')).toBeNull();
      expect(backend.loadCalls).toBe(1);

      // 越过节流窗口且故障恢复：embed 触发后台重试
      vi.setSystemTime(Date.now() + WARMUP_RETRY_INTERVAL_MS + 1);
      backend.failLoad = false;
      expect(await service.embedQuery('x')).toBeNull(); // 本次仍未就绪
      await vi.waitFor(() => expect(service.isReady()).toBe(true));
      expect(backend.loadCalls).toBe(2);

      // 就绪后正常出向量
      expect(await service.embedQuery('x')).not.toBeNull();
    });
  });
});

describe('进程隔离后端接线（方案 B）', () => {
  it('传 onnxChildEntryPath + 注入 fork：子进程崩溃 → warmup 失败 → 接口降级返回 null（不抛不崩）', async () => {
    const dir = await tmpDir();
    // 假 fork：子进程一收到 load 就“崩溃退出”，永不回 loaded。
    const crashingFork = () => {
      const exitCbs: ((c: number | null) => void)[] = [];
      return {
        send: (msg: { type: string }) => {
          if (msg.type === 'load') queueMicrotask(() => exitCbs.forEach((cb) => cb(134)));
        },
        on: (event: string, cb: (arg?: never) => void) => {
          if (event === 'exit') exitCbs.push(cb as never);
        },
        kill: () => {},
      };
    };
    const service = new LocalEmbeddingService({
      onnxChildEntryPath: '/fake/onnx-embed-child.mjs',
      fork: crashingFork as never,
      cacheDir: path.join(dir, 'cache'),
      modelsDir: path.join(dir, 'models'),
    });
    await expect(service.warmup()).rejects.toThrow(/退出/);
    expect(service.isReady()).toBe(false);
    // 关键：宿主侧接口降级为 null，绝不抛错、绝不崩
    expect(await service.embedQuery('x')).toBeNull();
    expect(await service.embedPassages(['a', 'b'])).toEqual([null, null]);
  });
});

describe('查询向量', () => {
  it('自动附加 query 前缀且 LRU 命中不重复推理', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();

    await service.embedQuery('帮我截个图');
    await service.embedQuery('帮我截个图');
    const queryCalls = backend.embedCalls.filter((c) => c[0].startsWith(QUERY_PREFIX));
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0][0]).toBe(`${QUERY_PREFIX}帮我截个图`);
  });

  it('并发同一查询只推理一次（进行中去重）', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();

    const [a, b, c] = await Promise.all([
      service.embedQuery('同一句话'),
      service.embedQuery('同一句话'),
      service.embedQuery('同一句话'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(backend.embedCalls).toHaveLength(1);
  });

  it('推理失败返回 null 不抛错', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();
    backend.failEmbed = true;
    expect(await service.embedQuery('x')).toBeNull();
  });
});

describe('候选向量缓存', () => {
  it('附加 passage 前缀；第二次调用全部命中缓存零推理', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();

    const texts = ['take a screenshot', 'send an email'];
    const first = await service.embedPassages(texts);
    expect(first.every((v) => v !== null)).toBe(true);
    expect(backend.embedCalls).toHaveLength(1);
    expect(backend.embedCalls[0][0]).toBe(`${PASSAGE_PREFIX}take a screenshot`);

    const second = await service.embedPassages(texts);
    expect(second.every((v) => v !== null)).toBe(true);
    expect(backend.embedCalls).toHaveLength(1); // 无新推理
  });

  it('部分命中时只推理未命中项', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();

    await service.embedPassages(['a']);
    await service.embedPassages(['a', 'b', 'c']);
    expect(backend.embedCalls[1]).toEqual([`${PASSAGE_PREFIX}b`, `${PASSAGE_PREFIX}c`]);
  });

  it('flush 后新 service 实例（同缓存目录）warmup 即命中', async () => {
    const backend = new FakeBackend();
    const dir = await tmpDir();
    const options = {
      backend,
      cacheDir: path.join(dir, 'cache'),
      modelsDir: path.join(dir, 'models'),
    };
    const first = new LocalEmbeddingService(options);
    await first.warmup();
    await first.embedPassages(['persist me']);
    await first.flush();

    const second = new LocalEmbeddingService(options);
    await second.warmup();
    const result = await second.embedPassages(['persist me']);
    expect(result[0]).not.toBeNull();
    // 两次 warmup 各 load 一次，但 embed 只发生在 first
    expect(backend.embedCalls).toHaveLength(1);
  });
});

describe('createSemanticScorer', () => {
  it('语义相近的候选得分高于无关候选', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();
    const scorer = createSemanticScorer(service);

    const results = await scorer.score(
      [
        { id: 'shot', text: 'capture a screenshot of the current window' },
        { id: 'mail', text: 'send an email to someone' },
      ],
      '帮我截图',
    );
    expect(results).not.toBeNull();
    const byId = new Map(results!.map((r) => [r.id, r.score]));
    expect(byId.get('shot')!).toBeGreaterThan(byId.get('mail')!);
  });

  it('服务未就绪时返回 null', async () => {
    const service = await makeService(new FakeBackend());
    const scorer = createSemanticScorer(service);
    expect(await scorer.score([{ id: 'a', text: 'a' }], 'q')).toBeNull();
  });

  it('空候选返回空数组（不推理）', async () => {
    const backend = new FakeBackend();
    const service = await makeService(backend);
    await service.warmup();
    const scorer = createSemanticScorer(service);
    expect(await scorer.score([], 'q')).toEqual([]);
    expect(backend.embedCalls).toHaveLength(0);
  });
});
