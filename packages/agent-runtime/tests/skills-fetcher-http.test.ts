import { describe, it, expect, vi } from 'vitest';
// W2.3：原 `middleware/skills-fetcher-http.ts` 已搬到 `skills/skills-fetcher-http.ts`
// 成为 SSoT 单源（middleware/ 整目录已删）。
import { createHttpSkillsFetcher } from '../src/skills/skills-fetcher-http.js';

// ───  + ：业务 id 从「per-call context」改为「host 装配期烘进 options」──
//
//  把 `SkillsFetchContext` 里的业务 id（原来是 spaceId / organizationId）剥离，
// 改由 host 装配期烘进 fetch 闭包。#7118 又把 Skill HTTP 的租户键从
// space_id 硬切到 (organization_id, agent_id)，因此本套测试直接烘 defaultOrganizationId
// （必需）与 defaultAgentId（可选），context 传空对象。

function makeMockFetch(responseJson: unknown, status = 200) {
  return vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseJson,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('createHttpSkillsFetcher', () => {
  it('returns null when baked organizationId is missing', async () => {
    // ：不烘 defaultOrganizationId → fetcher 无组织身份，直接返回 null（不注入）。
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      fetchImpl: makeMockFetch({ data: { skills: [] } }),
    });
    const result = await fetcher({});
    expect(result).toBeNull();
  });

  it('returns null when token is missing', async () => {
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => null,
      defaultOrganizationId: 'org-1',
      fetchImpl: makeMockFetch({ data: { skills: [{ skill_id: 'x', name: 'X' }] } }),
    });
    const result = await fetcher({});
    expect(result).toBeNull();
  });

  it('formats skills as <skills> body lines', async () => {
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'org-1',
      fetchImpl: makeMockFetch({
        data: {
          skills: [
            { skill_id: 'demo-skill', name: 'Demo Skill', description: 'Send demo messages', source: 'managed' },
            { skill_id: 'tabdata-query', name: 'TabData Query', description: 'Query rows', source: 'bundled' },
          ],
        },
      }),
    });
    const result = await fetcher({});
    expect(result).not.toBeNull();
    const content = result!.formattedContent;
    expect(content).toContain('你有 2 个可用技能');
    expect(content).toContain('`demo-skill` (managed): Send demo messages');
    expect(content).toContain('`tabdata-query` (bundled): Query rows');
    expect(result!.skills).toHaveLength(2);
    expect(result!.skills[0]!.canonicalKey).toBe('demo-skill');
  });

  it('prefers canonical skill_key over short skill_id', async () => {
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'org-1',
      fetchImpl: makeMockFetch({
        data: {
          skills: [
            {
              skill_id: 'table-query',
              skill_key: 'app:tabdata/table-query',
              name: 'Table Query',
              description: 'Query rows',
              source: 'app',
            },
          ],
        },
      }),
    });

    const result = await fetcher({});

    expect(result!.formattedContent).toContain('`app:tabdata/table-query` (app): Query rows');
    expect(result!.skills[0]!.canonicalKey).toBe('app:tabdata/table-query');
  });

  it('returns null on empty skills list', async () => {
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'org-1',
      fetchImpl: makeMockFetch({ data: { skills: [] } }),
    });
    const content = await fetcher({});
    expect(content).toBeNull();
  });

  it('caches results by baked (organizationId, agentId) for TTL window', async () => {
    // ：organizationId / agentId 是 per-runtime 常量，烘进闭包。缓存键
    // 是 `${organizationId}|${agentId}`，同一 fetcher 内为常量——TTL 窗口内多次
    // 调用只打一次网络。切换组织 / Agent 由 host 重建 fetcher 承担（另一实例，天然隔离）。
    const mock = makeMockFetch({
      data: { skills: [{ skill_id: 'x', name: 'X', description: 'd', source: 'm' }] },
    });
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      cacheTtlMs: 60_000,
      defaultOrganizationId: 'org-1',
      defaultAgentId: 'agent-1',
      fetchImpl: mock,
    });
    await fetcher({});
    await fetcher({});
    expect(mock).toHaveBeenCalledTimes(1);
    // Agent 变了 → host 会重建成另一个 fetcher 实例（独立缓存），这里用新实例验证隔离。
    const otherAgentFetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      cacheTtlMs: 60_000,
      defaultOrganizationId: 'org-1',
      defaultAgentId: 'agent-2',
      fetchImpl: mock,
    });
    await otherAgentFetcher({});
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('returns null on HTTP error without throwing', async () => {
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'org-1',
      fetchImpl: makeMockFetch({}, 500),
    });
    const content = await fetcher({});
    expect(content).toBeNull();
  });

  it('returns null on fetch network error without throwing', async () => {
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'org-1',
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const content = await fetcher({});
    expect(content).toBeNull();
  });

  // W7b M3 P0-2 修复：失败结果不进缓存，让网络一恢复立即重试
  it('does NOT cache failure results — recovers on next call when network returns', async () => {
    let attemptCount = 0;
    const mock = vi.fn(async (_url: string) => {
      attemptCount++;
      if (attemptCount === 1) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { skills: [{ skill_id: 'recovered', name: 'X', description: 'd', source: 'm' }] } }),
      } as Response;
    }) as unknown as typeof fetch;

    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      cacheTtlMs: 60_000,
      defaultOrganizationId: 'org-1',
      fetchImpl: mock,
    });

    const r1 = await fetcher({});
    expect(r1).toBeNull();
    const r2 = await fetcher({});
    expect(r2).not.toBeNull();
    expect(r2!.formattedContent).toContain('recovered');
    expect(attemptCount).toBe(2);
  });

  it('does NOT cache when token is missing', async () => {
    let tokenCallCount = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { skills: [{ skill_id: 'x', name: 'X', description: 'd', source: 'm' }] } }),
    } as Response)) as unknown as typeof fetch;

    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => {
        tokenCallCount++;
        return tokenCallCount === 1 ? null : 'token';
      },
      cacheTtlMs: 60_000,
      defaultOrganizationId: 'org-1',
      fetchImpl: fetchMock,
    });

    const r1 = await fetcher({});
    expect(r1).toBeNull();
    const r2 = await fetcher({});
    expect(r2).not.toBeNull();
    expect(r2!.formattedContent).toContain('你有 1 个可用技能');
  });

  it('caches successful empty list (200 + no skills) for TTL window', async () => {
    const mock = makeMockFetch({ data: { skills: [] } });
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      cacheTtlMs: 60_000,
      defaultOrganizationId: 'org-1',
      fetchImpl: mock,
    });
    const r1 = await fetcher({});
    const r2 = await fetcher({});
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('uses baked defaultOrganizationId + defaultAgentId in the request URL', async () => {
    const mock = makeMockFetch({
      data: { skills: [{ skill_id: 's1', name: 'S1', description: 'd', source: 'managed' }] },
    });
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'baked-org',
      defaultAgentId: 'baked-agent',
      fetchImpl: mock,
    });
    const result = await fetcher({});
    expect(result).not.toBeNull();
    expect(result!.formattedContent).toContain('你有 1 个可用技能');
    const requestedUrl = (mock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(requestedUrl).toContain('organization_id=baked-org');
    expect(requestedUrl).toContain('agent_id=baked-agent');
  });

  it('#7118: ignores per-call context, only uses host-baked ids', async () => {
    // 回归：`SkillsFetchContext` 不再携带业务 id，即便调用方臆想传业务字段，
    // fetcher 也只认烘焙值。这里 context 为空对象，URL 用烘焙的 baked-org。
    const mock = makeMockFetch({ data: { skills: [] } });
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'baked-org',
      fetchImpl: mock,
    });
    await fetcher({});
    const requestedUrl = (mock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(requestedUrl).toContain('organization_id=baked-org');
    expect(requestedUrl).not.toContain('space_id=');
  });

  it('truncates very long descriptions', async () => {
    const longDesc = 'x'.repeat(500);
    const fetcher = createHttpSkillsFetcher({
      apiBaseUrl: 'https://api.example.com/api',
      getToken: async () => 'token',
      defaultOrganizationId: 'org-1',
      fetchImpl: makeMockFetch({
        data: { skills: [{ skill_id: 'long', name: 'Long', description: longDesc, source: 'managed' }] },
      }),
    });
    const result = await fetcher({});
    expect(result).not.toBeNull();
    const content = result!.formattedContent;
    expect(content).toContain('long');
    expect(content.includes('...')).toBe(true);
    expect(content.length).toBeLessThan(longDesc.length + 200);
  });
});
