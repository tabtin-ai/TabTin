/**
 * Wave 1.5 PROD-3 · 共享 SkillCredentialResolver 单测
 *
 * 验证 `@tabtin/agent-host/credentials` 的行为
 * （Electron + Daemon 共用同一份实现），覆盖 HTTP / 缓存 / 失效 / 降级 /
 * warnings 透传等语义。
 *
 * 不测 "Electron 的 createLogger 适配"或"Daemon 的 Logger 适配"——那是
 * 宿主层薄桥接，本测试关注的是共享行为本身。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createSkillCredentialResolver } from '../src/credentials/skill-credential-resolver.js';

function makeFetchMock(
  responses: Array<{ status: number; body: Record<string, unknown> }>,
): typeof fetch {
  let callIndex = 0;
  return vi.fn(async (_url: unknown, _init?: unknown) => {
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('Wave 1.5 PROD-3 · shared SkillCredentialResolver', () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('命中 200：返回 injection，并缓存（第二次同 key 校验 active 后仍命中）', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('/skill-reveal')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            credential_id: 'cred-1',
            service_name: 'openai',
            env: { OPENAI_API_KEY: 'sk-long-enough-key' },
          }),
        } as unknown as Response;
      }
      if (urlStr.includes('/credential-vault/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'cred-1', is_active: true }],
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${urlStr}`);
    }) as unknown as typeof fetch;
    const { resolver, stats } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt-token',
      fetchImpl,
    });

    const first = await resolver({
      skillKey: 'user:x', spaceId: 'space-a', agentId: 'agent-a' },
      signal,
    );
    const second = await resolver({
      skillKey: 'user:x', spaceId: 'space-a', agentId: 'agent-a' },
      signal,
    );

    expect(first?.env.OPENAI_API_KEY).toBe('sk-long-enough-key');
    expect(second?.env.OPENAI_API_KEY).toBe('sk-long-enough-key');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stats().hits).toBe(1);
    expect(stats().misses).toBe(1);
  });

  it('缓存命中但凭据已停用 → 清缓存并返回 null', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('/skill-reveal')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            credential_id: 'cred-inactive',
            service_name: 'openai',
            env: { OPENAI_API_KEY: 'sk-long-enough-key' },
          }),
        } as unknown as Response;
      }
      if (urlStr.includes('/credential-vault/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'cred-inactive', is_active: false }],
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${urlStr}`);
    }) as unknown as typeof fetch;

    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt-token',
      fetchImpl,
    });

    const first = await resolver({
      skillKey: 'user:x', spaceId: 'space-a', agentId: 'agent-a' }, signal);
    expect(first?.env.OPENAI_API_KEY).toBe('sk-long-enough-key');

    const second = await resolver({
      skillKey: 'user:x', spaceId: 'space-a', agentId: 'agent-a' }, signal);
    expect(second).toBeNull();
  });

  it('200 带 warnings：透传到 injection.warnings（PROD-5 冲突响应）', async () => {
    const fetchImpl = makeFetchMock([
      {
        status: 200,
        body: {
          success: true,
          credential_id: 'cred-2',
          service_name: 'openai',
          env: { OPENAI_API_KEY: 'sk-long-enough' },
          warnings: ['primary_env_ignored_for_mapped_service'],
        },
      },
    ]);
    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt',
      fetchImpl,
    });

    const result = await resolver({
      skillKey: 'user:x', spaceId: 'space-a', agentId: 'agent-a', primaryEnv: 'MY_CUSTOM_KEY' },
      signal,
    );
    expect(result?.warnings).toEqual(['primary_env_ignored_for_mapped_service']);
  });

  it('无 token：不发 HTTP，直接返回 null（Daemon 无头部署场景）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => undefined,
      fetchImpl,
    });

    const result = await resolver({
      skillKey: 'user:x', spaceId: 'space-a', agentId: 'agent-a' },
      signal,
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('getApiAuthToken 用 getter：后续刷新立即生效', async () => {
    let currentToken: string | undefined = 'old-token';
    const capturedHeaders: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      const req = init as { headers?: Record<string, string> };
      capturedHeaders.push({ ...(req?.headers ?? {}) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          credential_id: 'c',
          service_name: 'openai',
          env: { OPENAI_API_KEY: 'sk-long-key-xyz' },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => currentToken,
      fetchImpl,
    });

    await resolver({
      skillKey: 'user:a', spaceId: 'sp', agentId: 'agent-a' }, signal);
    currentToken = 'new-token';
    // 换 skillKey 避免命中缓存
    await resolver({
      skillKey: 'user:b', spaceId: 'sp', agentId: 'agent-a' }, signal);

    expect(capturedHeaders[0].Authorization).toBe('Bearer old-token');
    expect(capturedHeaders[1].Authorization).toBe('Bearer new-token');
  });

  it('网络错误：静默降级返回 null，不进缓存', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const logs: Array<{ level: string; message: string }> = [];
    const { resolver, stats } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt',
      fetchImpl,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg) => logs.push({ level: 'warn', message: msg }),
      },
    });

    const r1 = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' }, signal);
    const r2 = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' }, signal);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    // 两次都发 HTTP（没进缓存）
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stats().errors).toBe(2);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('HTTP 4xx：info 日志 + 返回 null，不进缓存', async () => {
    const fetchImpl = makeFetchMock([
      { status: 404, body: { success: false, code: 'SKILL_NOT_BOUND' } },
    ]);
    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt',
      fetchImpl,
    });
    const r = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' }, signal);
    expect(r).toBeNull();
  });

  it('invalidate({ skillKey }) 清除对应 entry', async () => {
    const fetchImpl = makeFetchMock([
      {
        status: 200,
        body: {
          success: true,
          credential_id: 'c1',
          service_name: 'openai',
          env: { OPENAI_API_KEY: 'sk-first-long-key' },
        },
      },
      {
        status: 200,
        body: {
          success: true,
          credential_id: 'c1',
          service_name: 'openai',
          env: { OPENAI_API_KEY: 'sk-second-long-key' },
        },
      },
    ]);
    const { resolver, invalidate } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt',
      fetchImpl,
    });

    const r1 = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' }, signal);
    expect(r1?.env.OPENAI_API_KEY).toBe('sk-first-long-key');
    invalidate({ skillKey: 'user:x' });
    const r2 = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' }, signal);
    expect(r2?.env.OPENAI_API_KEY).toBe('sk-second-long-key');
  });

  it('HTTP 契约：POST 方法 + 正确 URL + 蛇形 body 字段（避免前后端字段漂移）', async () => {
    // 三视角 Review 修复（技术 4）：后端 Django endpoint 期望的 body 是
    // `{ space_id, agent_id, skill_key, primary_env? }`（下划线蛇形）。哪天前端
    // refactor 误改成驼峰 / 后端改字段名，静默 400。这里锁死契约。
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: unknown) => {
      captured.push({ url: String(url), init: init as RequestInit });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          credential_id: 'c',
          service_name: 'openai',
          env: { OPENAI_API_KEY: 'sk-long-enough-key' },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt-token',
      organizationId: 'wt-1',
      fetchImpl,
    });

    await resolver({
      skillKey: 'user:demo-table', spaceId: 'sp-123', agentId: 'agent-a', primaryEnv: 'DEMO_APP_ID' },
      signal,
    );

    expect(captured).toHaveLength(1);
    const [{ url, init }] = captured;
    expect(url).toBe('https://api.example/api/credential-vault/api-key/skill-reveal');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-TabTin-Organization-Id']).toBe('wt-1');

    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      space_id: 'sp-123',
      agent_id: 'agent-a',
      skill_key: 'user:demo-table',
      primary_env: 'DEMO_APP_ID',
    });
  });

  it('60s TTL 过期：第二次同 key 调用会重发 fetch（不命中过期缓存）', async () => {
    // 三视角 Review 修复（技术 4）：CACHE_TTL_MS 是共享模块的关键不变量，
    // 没 fake timer 测试意味着谁改成 0 / 50h / 把 `<=` 改成 `<` 测试全绿。
    // Wave 2a：TTL 从 5min 收紧到 60s（PD-4 撤权语义收窄）。
    vi.useFakeTimers();
    try {
      let skillRevealCalls = 0;
      let listCalls = 0;
      const fetchImpl = vi.fn(async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes('/skill-reveal')) {
          skillRevealCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              credential_id: 'c1',
              service_name: 'openai',
              env: {
                OPENAI_API_KEY: skillRevealCalls === 1
                  ? 'sk-first-long-key'
                  : 'sk-second-long-key',
              },
            }),
          } as unknown as Response;
        }
        if (urlStr.includes('/credential-vault/list')) {
          listCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => [{ id: 'c1', is_active: true }],
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch url: ${urlStr}`);
      }) as unknown as typeof fetch;

      const { resolver } = createSkillCredentialResolver({
        apiBaseUrl: 'https://api.example/api',
        getApiAuthToken: () => 'jwt',
        fetchImpl,
      });

      const first = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' },
        signal,
      );
      expect(first?.env.OPENAI_API_KEY).toBe('sk-first-long-key');
      expect(skillRevealCalls).toBe(1);

      // 50 秒内命中缓存（TTL=60s），会额外触发 active-check list
      vi.advanceTimersByTime(50 * 1000);
      const hit = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' },
        signal,
      );
      expect(hit?.env.OPENAI_API_KEY).toBe('sk-first-long-key');
      expect(skillRevealCalls).toBe(1);
      expect(listCalls).toBe(1);

      // 再推进 15 秒（总 65 秒）——过期，应重发 skill-reveal
      vi.advanceTimersByTime(15 * 1000);
      const afterExpiry = await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' },
        signal,
      );
      expect(afterExpiry?.env.OPENAI_API_KEY).toBe('sk-second-long-key');
      expect(skillRevealCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logger 仅打元数据（credentialId / serviceName / envVars），不泄漏 value', async () => {
    const SECRET = 'test-api-key';
    const fetchImpl = makeFetchMock([
      {
        status: 200,
        body: {
          success: true,
          credential_id: 'cred',
          service_name: 'openai',
          env: { OPENAI_API_KEY: SECRET },
        },
      },
    ]);
    const records: string[] = [];
    const { resolver } = createSkillCredentialResolver({
      apiBaseUrl: 'https://api.example/api',
      getApiAuthToken: () => 'jwt',
      fetchImpl,
      logger: {
        debug: (msg, fields) => records.push(`${msg} ${JSON.stringify(fields ?? {})}`),
        info: (msg, fields) => records.push(`${msg} ${JSON.stringify(fields ?? {})}`),
        warn: (msg, fields) => records.push(`${msg} ${JSON.stringify(fields ?? {})}`),
      },
    });

    await resolver({
      skillKey: 'user:x', spaceId: 'sp', agentId: 'agent-a' }, signal);
    const all = records.join('\n');
    expect(all).not.toContain(SECRET);
  });
});
