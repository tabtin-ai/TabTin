import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ReadFileState,
  ReadFileStateEntry,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import { createMockProvider, createMockPermissionHandler, createMockToolProvider } from './test-utils.js';

let capturedConfig: EngineConfig | undefined;

vi.mock('../src/runtime-assembly.js', () => ({
  createDefaultQueryDeps: vi.fn(),
  createRuntime: (config: EngineConfig) => {
    capturedConfig = config;
    return {
      async *query() {
        yield { type: 'agent.stream.done', payload: { content: 'done' } };
      },
    };
  },
}));

vi.mock('../src/session/storage.js', () => ({
  SessionStorage: vi.fn().mockImplementation(() => ({
    recordAssistantMessage: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// 阶段 8 可观测性接入后 fork-query 会构造 Snapshot/Event/SubagentIndex 三件套。
// 本套测试只断言 EngineConfig 字段透传，与可观测性无关——全部 mock 成 no-op，
// 避免真实写 `/tmp/s/...` 留垃圾文件。
vi.mock('../src/session/snapshot-storage.js', () => ({
  SnapshotStorage: vi.fn().mockImplementation(() => ({
    // 阶段 8 Review fix：fork-query.ts 读 `storage.filePath` 拼 paths.snapshotsPath
    // 然后 path.relative(parentSessionAbsDir, this.filePath)——mock 必须提供具体
    // 字符串否则 path.relative 抛 ERR_INVALID_ARG_TYPE 整轮 fork 失败。
    filePath: '/tmp/mocked-snapshots.jsonl',
    append: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../src/session/event-storage.js', () => ({
  EventStorage: vi.fn().mockImplementation(() => ({
    filePath: '/tmp/mocked-events.jsonl',
    append: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../src/session/subagent-index.js', () => ({
  SubagentIndexWriter: vi.fn().mockImplementation(() => ({
    recordStart: vi.fn().mockResolvedValue(undefined),
    recordEnd: vi.fn().mockResolvedValue(undefined),
    getFilePath: vi.fn().mockReturnValue('/tmp/mocked-subagents.jsonl'),
  })),
}));

const { forkQuery } = await import('../src/subagent/fork-query.js');

function makeEntry(content: string): ReadFileStateEntry {
  // W2（2026-05-10）：旧实现写 `mtimeMs` / `isPartialView` 与 ReadFileStateEntry
  // 真实字段（`timestamp` / 已删 isPartialView）漂移；`Map.set/get` 不会触发字段读
  // 所以测试假性通过。同步对齐 W1 改名 `mtimeMs → timestamp` + W2 删 isPartialView。
  return { content, timestamp: Date.now(), readAt: Date.now() };
}

describe('forkQuery readFileState isolation (L-8 / PRD 06 §7.1)', () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  it('child receives a cloned Map, not the parent reference', async () => {
    const parentMap: ReadFileState = new Map();
    parentMap.set('/a.ts', makeEntry('parent-content'));

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      readFileState: parentMap,
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig).toBeDefined();
    const childMap = capturedConfig!.readFileState!;
    expect(childMap).toBeInstanceOf(Map);
    expect(childMap).not.toBe(parentMap);
    expect(childMap.get('/a.ts')?.content).toBe('parent-content');
  });

  it('child writes do not affect parent Map', async () => {
    const parentMap: ReadFileState = new Map();
    parentMap.set('/a.ts', makeEntry('original'));

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      readFileState: parentMap,
    });

    for await (const _ of gen) { /* drain */ }

    const childMap = capturedConfig!.readFileState!;
    childMap.set('/b.ts', makeEntry('child-only'));
    childMap.set('/a.ts', makeEntry('child-modified'));

    expect(parentMap.has('/b.ts')).toBe(false);
    expect(parentMap.get('/a.ts')?.content).toBe('original');
  });

  it('passes undefined when parent has no readFileState', async () => {
    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.readFileState).toBeUndefined();
  });
});

// ─── W2 (2026-05-13): image / localDoc dedup state fork 透传 ──────────
//
// 与 readFileState 同款 per-fork 隔离 clone：父→子 shallow clone，子继承
// 父"已读过哪些图 / 文档"的判等签名，但子的写入不污染父级。
describe('forkQuery imageReadFileState / localDocReadFileState isolation (W2)', () => {
  it('child receives cloned image dedup Map; child writes do not affect parent', async () => {
    const parentImg: Map<string, {
      mtimeMs: number; sizeBytes: number; sha256: string; readAt: number;
      mediaType: string; base64Bytes: number; wasResized: boolean;
    }> = new Map();
    parentImg.set('/sample.png', {
      mtimeMs: 1000, sizeBytes: 100, sha256: 'abc', readAt: Date.now(),
      mediaType: 'image/png', base64Bytes: 200, wasResized: false,
    });

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      imageReadFileState: parentImg as unknown as NonNullable<EngineConfig['imageReadFileState']>,
    });
    for await (const _ of gen) { /* drain */ }

    const childImg = capturedConfig!.imageReadFileState!;
    expect(childImg).not.toBe(parentImg);
    expect(childImg.get('/sample.png')?.sha256).toBe('abc');

    // 子写入不污染父
    childImg.set('/child-only.png', {
      mtimeMs: 2000, sizeBytes: 200, sha256: 'def', readAt: Date.now(),
      mediaType: 'image/png', base64Bytes: 400, wasResized: false,
    });
    expect(parentImg.has('/child-only.png')).toBe(false);
  });

  it('child receives cloned localDoc dedup Map; per-fork isolation', async () => {
    const parentDoc: Map<string, {
      mtimeMs: number; sizeBytes: number; sha256: string; readAt: number;
      mimeType: string; textBytes: number;
    }> = new Map();
    parentDoc.set('/x.pdf', {
      mtimeMs: 1000, sizeBytes: 5000, sha256: 'xyz', readAt: Date.now(),
      mimeType: 'application/pdf', textBytes: 1000,
    });

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      localDocReadFileState: parentDoc as unknown as NonNullable<EngineConfig['localDocReadFileState']>,
    });
    for await (const _ of gen) { /* drain */ }

    const childDoc = capturedConfig!.localDocReadFileState!;
    expect(childDoc).not.toBe(parentDoc);
    expect(childDoc.get('/x.pdf')?.sha256).toBe('xyz');

    childDoc.set('/y.pdf', {
      mtimeMs: 2000, sizeBytes: 7000, sha256: 'yyy', readAt: Date.now(),
      mimeType: 'application/pdf', textBytes: 2000,
    });
    expect(parentDoc.has('/y.pdf')).toBe(false);
  });

  it('parent without dedup states → child also undefined', async () => {
    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
    });
    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.imageReadFileState).toBeUndefined();
    expect(capturedConfig!.localDocReadFileState).toBeUndefined();
  });
});
