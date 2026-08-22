/**
 * `memo-sync-client` 单元测试（PRD 05 v0.4 §7.3 + §8.1.2）。
 *
 * 覆盖矩阵：
 *
 * Commit client：
 *   1. PUT 成功路径：URL/headers/body 全对 + If-Match 取 getCurrentGeneration
 *   2. token 缺失：跳过 fetch + log warn（不抛）
 *   3. token getter 抛错：log warn + 不发请求
 *   4. 网络失败（fetch reject）：log warn + 不抛
 *   5. 409 GENERATION_CONFLICT：log warn + 不重试
 *   6. 5xx 一般失败：log warn + 不抛
 *   7. 401/403：log warn + 不抛
 *
 * Refetch client：
 *   8. GET 成功路径 + snake_case → camelCase 转换
 *   9. token 缺失：抛错（让 store 走 fail-soft 通道兜底）
 *   10. 网络失败：抛错
 *   11. envelope success=false：抛错
 *   12. JSON parse 失败：抛错
 *   13. 空 entries / 不带 reason / approver_user_id：仍能解析，缺字段不写入
 *
 * Snapshot 解析（parseApprovalMemoSnapshot 单测）：
 *   14. 非法 decision 跳过
 *   15. generation 非数字 → fallback 0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createApprovalMemoCommitClient,
  createApprovalMemoRefetchClient,
  parseApprovalMemoSnapshot,
} from '../src/permissions/memo-sync-client.js';

// 与生产保持一致：apiBaseUrl 由 tabtin-config.normalizeApiBaseUrl 规范化为
// 必带 /api 后缀（packages/tabtin-config/src/index.ts:135）；测试 BASE_URL
// 也带 /api，避免"测试通过但 dogfood 出双 /api/api/"的语义割裂。
const BASE_URL = 'http://api.test.local/api';
const AGENT_ID = 'agent-uuid-123';

function makeFetchMock(responses: Array<Partial<Response> & { jsonValue?: unknown; throwError?: Error }>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (r.throwError) throw r.throwError;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: async () => r.jsonValue,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('createApprovalMemoCommitClient', () => {
  let warnSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    warnSpy = vi.fn();
  });

  it('1. PUT success: URL/headers/body/If-Match all correct + onCommitGenerationAdvance triggered', async () => {
    const fetchMock = makeFetchMock([{
      ok: true,
      status: 200,
      jsonValue: { success: true, data: { generation: 8 } },
    }]);
    const advanceSpy = vi.fn();
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok-1',
      getCurrentGeneration: () => 7,
      onCommitGenerationAdvance: advanceSpy,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('ns::bash::npm install', {
      decision: 'allow',
      createdAt: 1,
      updatedAt: 1,
      approverUserId: 'u-1',
      reason: 'Trust npm install',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // path 里**不要**重复 /api 前缀（代码侧已修；BASE_URL 自带 /api 后缀）
    expect(url).toBe(`${BASE_URL}/context/workspaces/${AGENT_ID}/approval-memo/ns%3A%3Abash%3A%3Anpm%20install`);
    expect(init.method).toBe('PUT');
    expect(init.headers['Authorization']).toBe('Bearer tok-1');
    expect(init.headers['If-Match']).toBe('7');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    // M4.1 L-W6-24：PUT body 包含 scope_description（空时为 ""）
    expect(body).toEqual({ decision: 'allow', reason: 'Trust npm install', scope_description: '' });
    expect(warnSpy).not.toHaveBeenCalled();
    // W2-轮 2 自修复 CRITICAL #1：commit 200 后必须把 server gen 推给 store
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(advanceSpy).toHaveBeenCalledWith(8);
  });

  it('2. no auth token: skip request + no warn', async () => {
    const fetchMock = makeFetchMock([{ ok: true }]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => null,
      getCurrentGeneration: () => 0,
      fetchImpl: fetchMock,
      log: { warn: warnSpy, debug: vi.fn() },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled(); // 没 token 不算错
  });

  it('3. token getter throws: log warn + no fetch', async () => {
    const fetchMock = makeFetchMock([{ ok: true }]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => {
        throw new Error('token fetch boom');
      },
      getCurrentGeneration: () => 0,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('token fetch failed');
  });

  it('4. network failure: log warn + does not throw', async () => {
    const fetchMock = makeFetchMock([{ throwError: new Error('ECONNREFUSED') }]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 0,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await expect(commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('network error');
  });

  it('5. 409 GENERATION_CONFLICT: log warn + onConflict triggered', async () => {
    const fetchMock = makeFetchMock([
      {
        ok: false,
        status: 409,
        jsonValue: {
          success: false,
          code: 'GENERATION_CONFLICT',
          data: { current_generation: 12 },
        },
      },
    ]);
    const onConflictSpy = vi.fn();
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 7,
      onConflict: onConflictSpy,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('commit conflict');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('server gen=12');
    // W2-轮 2 自修复 CRITICAL #3：409 必须主动 maybeRefetch（不仅依赖 WS）
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    expect(onConflictSpy).toHaveBeenCalledWith(12);
  });

  it('6. generic 500: log warn + not throw', async () => {
    const fetchMock = makeFetchMock([
      { ok: false, status: 500, jsonValue: { code: 'INTERNAL_ERROR' } },
    ]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 0,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('status=500');
  });

  it('7. 401 auth failure: log warn + not throw', async () => {
    const fetchMock = makeFetchMock([
      { ok: false, status: 401, jsonValue: { code: 'AUTH_INVALID' } },
    ]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 0,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('status=401');
  });
});

describe('createApprovalMemoRefetchClient', () => {
  it('8. GET success: snake_case → camelCase + entries parsed', async () => {
    const fetchMock = makeFetchMock([
      {
        ok: true,
        status: 200,
        jsonValue: {
          success: true,
          code: 'SUCCESS',
          data: {
            version: 1,
            entries: {
              'ns::bash::ls': {
                decision: 'allow',
                created_at: 100,
                updated_at: 200,
                approver_user_id: 'u-1',
                reason: 'OK',
              },
              'ns::write::file': {
                decision: 'deny',
                created_at: 300,
                updated_at: 400,
                approver_user_id: 'u-2',
                reason: '',
              },
            },
            generation: 9,
          },
        },
      },
    ]);
    const refetch = createApprovalMemoRefetchClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: async () => 'tok',
      fetchImpl: fetchMock,
    });
    const snapshot = await refetch();
    expect(snapshot.generation).toBe(9);
    expect(Object.keys(snapshot.entries).sort()).toEqual(['ns::bash::ls', 'ns::write::file']);
    expect(snapshot.entries['ns::bash::ls']).toMatchObject({
      decision: 'allow',
      createdAt: 100,
      updatedAt: 200,
      approverUserId: 'u-1',
      reason: 'OK',
    });
    expect(snapshot.entries['ns::write::file']).toMatchObject({
      decision: 'deny',
      createdAt: 300,
      updatedAt: 400,
    });
  });

  it('9. no token: throws', async () => {
    const fetchMock = makeFetchMock([{ ok: true }]);
    const refetch = createApprovalMemoRefetchClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => null,
      fetchImpl: fetchMock,
    });
    await expect(refetch()).rejects.toThrow(/no auth token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('10. network failure: throws', async () => {
    const fetchMock = makeFetchMock([{ throwError: new Error('ECONNRESET') }]);
    const refetch = createApprovalMemoRefetchClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      fetchImpl: fetchMock,
    });
    await expect(refetch()).rejects.toThrow(/ECONNRESET/);
  });

  it('11. envelope success=false: throws', async () => {
    const fetchMock = makeFetchMock([
      { ok: true, status: 200, jsonValue: { success: false, code: 'NOT_FOUND' } },
    ]);
    const refetch = createApprovalMemoRefetchClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      fetchImpl: fetchMock,
    });
    await expect(refetch()).rejects.toThrow(/code=NOT_FOUND/);
  });

  it('12. JSON parse failure: throws', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
    })) as unknown as typeof fetch;
    const refetch = createApprovalMemoRefetchClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      fetchImpl: fetchMock,
    });
    await expect(refetch()).rejects.toThrow(/JSON parse failed/);
  });

  it('13. empty entries + missing optional fields: still parseable', async () => {
    const fetchMock = makeFetchMock([
      {
        ok: true,
        status: 200,
        jsonValue: {
          success: true,
          data: {
            version: 1,
            entries: {
              'ns::tool::k': {
                decision: 'allow',
                created_at: 1,
                // 不带 updated_at / approver_user_id / reason
              },
            },
            generation: 0,
          },
        },
      },
    ]);
    const refetch = createApprovalMemoRefetchClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      fetchImpl: fetchMock,
    });
    const snap = await refetch();
    expect(snap.generation).toBe(0);
    expect(snap.entries['ns::tool::k']).toMatchObject({
      decision: 'allow',
      createdAt: 1,
      updatedAt: 1, // fallback to createdAt
    });
    expect(snap.entries['ns::tool::k'].approverUserId).toBeUndefined();
    expect(snap.entries['ns::tool::k'].reason).toBeUndefined();
  });
});

describe('createApprovalMemoCommitClient (W2-轮 2 race scenarios)', () => {
  let warnSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    warnSpy = vi.fn();
  });

  it('R1. batch 多条 always 串行 commit：generation 单调递增不撞 409', async () => {
    // 模拟 server 行为：每次 PUT generation+1，并把新值返回
    let serverGen = 0;
    const fetchMock = vi.fn(async () => {
      serverGen += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { generation: serverGen } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let clientGen = 0;
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => clientGen,
      onCommitGenerationAdvance: (g) => {
        // 模拟 store.advanceGeneration（单调推进）
        if (g > clientGen) clientGen = g;
      },
      fetchImpl: fetchMock,
      log: { warn: warnSpy, debug: vi.fn() },
    });

    // 模拟同 batch 3 条 always
    await commit('k1', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    await commit('k2', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    await commit('k3', { decision: 'allow', createdAt: 1, updatedAt: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(clientGen).toBe(3);

    // 验证每次发送的 If-Match 都是当前已知 server gen
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1].headers['If-Match']).toBe('0');
    expect(calls[1][1].headers['If-Match']).toBe('1');
    expect(calls[2][1].headers['If-Match']).toBe('2');
  });

  it('R2. onCommitGenerationAdvance throws: log warn + main path not affected', async () => {
    const fetchMock = makeFetchMock([
      { ok: true, status: 200, jsonValue: { success: true, data: { generation: 5 } } },
    ]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 0,
      onCommitGenerationAdvance: () => {
        throw new Error('store mutation boom');
      },
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await expect(commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('advanceGeneration callback threw');
  });

  it('R3. onConflict throws: log warn + main path resolves', async () => {
    const fetchMock = makeFetchMock([
      {
        ok: false,
        status: 409,
        jsonValue: { success: false, code: 'GENERATION_CONFLICT', data: { current_generation: 7 } },
      },
    ]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 1,
      onConflict: () => {
        throw new Error('refetch sync boom');
      },
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await expect(commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 })).resolves.toBeUndefined();
    // 1 条 conflict warn + 1 条 callback threw warn
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1]?.[0]).toContain('onConflict callback threw');
  });

  it('R4. onConflict async reject: log warn + main path resolves', async () => {
    const fetchMock = makeFetchMock([
      {
        ok: false,
        status: 409,
        jsonValue: { success: false, code: 'GENERATION_CONFLICT', data: { current_generation: 7 } },
      },
    ]);
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 1,
      onConflict: async () => {
        throw new Error('refetch async boom');
      },
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    // 微任务消化 reject
    await new Promise((r) => setImmediate(r));
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('onConflict refetch failed'))).toBe(true);
  });

  it('R5. commit success without server.data.generation: no advance call (defensive)', async () => {
    const fetchMock = makeFetchMock([
      // server 返回 200 但 data 缺 generation —— 不触发 advance（防御）
      { ok: true, status: 200, jsonValue: { success: true } },
    ]);
    const advanceSpy = vi.fn();
    const commit = createApprovalMemoCommitClient({
      apiBaseUrl: BASE_URL,
      workspaceId: AGENT_ID,
      getAuthToken: () => 'tok',
      getCurrentGeneration: () => 5,
      onCommitGenerationAdvance: advanceSpy,
      fetchImpl: fetchMock,
      log: { warn: warnSpy },
    });
    await commit('k', { decision: 'allow', createdAt: 1, updatedAt: 1 });
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('parseApprovalMemoSnapshot', () => {
  it('14. invalid decision values get skipped', () => {
    const snap = parseApprovalMemoSnapshot({
      version: 1,
      entries: {
        good: { decision: 'allow', created_at: 1, updated_at: 1 },
        bad: { decision: 'maybe', created_at: 1, updated_at: 1 },
        notObj: 'string-not-object' as unknown as Record<string, unknown>,
      } as Record<string, Record<string, unknown>>,
      generation: 5,
    });
    expect(Object.keys(snap.entries)).toEqual(['good']);
    expect(snap.generation).toBe(5);
  });

  it('15. missing / non-numeric generation falls back to 0', () => {
    expect(parseApprovalMemoSnapshot(null).generation).toBe(0);
    expect(parseApprovalMemoSnapshot(undefined).generation).toBe(0);
    expect(parseApprovalMemoSnapshot({ entries: {}, generation: 'oops' as unknown as number }).generation).toBe(0);
  });

  // M4.1 L-W6-24：normalizeServerEntry 解析 scope_description（跨设备 bootstrap 后仍显示人话）
  it('16. scope_description 从服务端拉回后写入 entry（bootstrap 不丢人话）', () => {
    const snap = parseApprovalMemoSnapshot({
      version: 1,
      entries: {
        k1: { decision: 'allow', created_at: 1, updated_at: 1, scope_description: '总是允许推送代码' },
        k2: { decision: 'deny', created_at: 2, updated_at: 2, scope_description: '' }, // 空字符串不写入
        k3: { decision: 'allow', created_at: 3, updated_at: 3 }, // 无字段不写入
      } as Record<string, Record<string, unknown>>,
      generation: 2,
    });
    expect(snap.entries['k1']?.scope_description).toBe('总是允许推送代码');
    expect(snap.entries['k2']?.scope_description).toBeUndefined();
    expect(snap.entries['k3']?.scope_description).toBeUndefined();
  });
});
